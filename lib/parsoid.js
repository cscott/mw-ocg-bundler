// Make concurrency-limited parsoid API requests.
"use strict";
require('es6-shim');
require('prfun');

var domino = require('domino');
var fs = require('fs');
var path = require('path');
var request = require('./retry-request');
var url = require('url');
var util = require('util');

var P = require('./p');

// limit the # of concurrent requests to parsoid.
var PARSOID_REQUEST_LIMIT = 5;

// Escape special regexp characters in a string.
// Used to build a regexp matching a literal string.
var escapeRegExp = function(s) {
	return s.replace(/[\^\\$*+?.()|{}\[\]\/]/g, '\\$&');
};

var Parsoid = module.exports = function(wikis, log) {
	this.wikis = wikis;
	this.log = log;
};

var ParsoidResult = function(parsoid, siteinfo, wiki, title, text) {
	this.wiki = wiki;
	this.title = title;
	this.text = text;
	this.imagesize = parsoid.wikis[wiki].imagesize;
	this.document = domino.createDocument(text);
	// create a regexp that matches the article path in order to resolve URLs
	// into titles.
	var m = /^([\s\S]*)\$1([\s\S]*)$/.exec(siteinfo.general.articlepath);
	this._resolve_re = new RegExp(
		'^' + escapeRegExp(m[1]) + '([\\s\\S]*)' + escapeRegExp(m[2]) + '$'
	);
};

// resolve an article title
ParsoidResult.prototype._resolve = function(href) {
	var path = url.parse(url.resolve(this.getBaseHref(), href), false, true).
		pathname;
	// now remove the articlepath
	var m = this._resolve_re.exec(path);
	return decodeURIComponent(m[1]);
};

ParsoidResult.prototype.getRedirect = function() {
	var redirect = this.document.querySelector(
		'link[rel="mw:PageProp/redirect"][href]'
	);
	if (redirect) {
		return this._resolve(redirect.getAttribute('href'));
	}
	return null; // no redirect
};

ParsoidResult.prototype.getBaseHref = function() {
	var result = '';
	var base = this.document.querySelector('head > base[href]');
	if (base) {
		result = base.getAttribute('href').replace(/^\/\//, 'https://');
	}
	this.getBaseHref = function() { return result; };
	return result;
};

ParsoidResult.prototype.getRevisionId = function() {
	var m = /revision\/(\d+)$/.exec(this.getAbout() || '');
	return m ? +(m[1]) : 0;
};

ParsoidResult.prototype.getAbout = function() {
	var html = this.document.querySelector('html[about]');
	return html && html.getAttribute('about');
};

ParsoidResult.prototype.getIsVersionOf = function() {
	var link = this.document.querySelector('link[rel=dc:isVersionOf]');
	return link && link.getAttribute('href');
};

ParsoidResult.prototype.getImages = function() {
	var base = this.getBaseHref();
	var imgs = this.document.querySelectorAll([
		'figure > * > img[resource]',
		'*[typeof="mw:Image"] > * > img[resource]',
		'*[typeof="mw:Image/Thumb"] > * > img[resource]'
	].join(','));
	return Array.prototype.map.call(imgs, function(img) {
		var relResourceURL = img.getAttribute('resource');
		var resourceURL = url.resolve(base, relResourceURL);
		var srcURL = url.resolve(base, img.getAttribute('src')); // thumb, etc
		return {
			wiki: this.wiki,
			short: this._resolve(relResourceURL),
			resource: resourceURL,
			src: srcURL,
			imagesize: this.imagesize
		};
	}.bind(this));
};

var fetch = function(siteinfo, wiki, title, revid /* optional */, max_redirects /* optional */, status /* optional */) {
	wiki = wiki || 0;
	max_redirects = max_redirects || 0;
	var prefix = this.wikis[wiki].prefix;
	if (status) {
		// this is inside the guard, so if we launch lots of fetches in
		// parallel, we won't report them all at once.
		status.report(null, util.format(
			'%s:%s [Parsoid, %s]', prefix, title,
			revid ? ('revision ' + revid) : 'latest revision'
		));
	}
	var deferred = Promise.defer();
	var result = deferred.promise.then(function(text) {
		// parse the article text
		var pr = new ParsoidResult(this, siteinfo, wiki, title, text);
		// check for redirects
		var ntitle = pr.getRedirect();
		if (ntitle && max_redirects > 0) {
			// use unguarded version of this method, so we don't end up
			// deadlocking if max_redirects > PARSOID_REQUEST_LIMIT
			return fetch.call(this, siteinfo, wiki, ntitle, null, max_redirects-1, null);
		}
		return pr;
	}.bind(this));

	// look-aside cache, mostly for quicker/offline dev
	try {
		var cachePath = path.join(__dirname, '..', 'cache', prefix, title);
		if (revid) { cachePath = path.join(cachePath, ''+revid); }
		var cached = fs.readFileSync(cachePath, 'utf8');
		deferred.resolve(cached);
		return result;
	} catch (e) {
		/* no cached version, do the actual API request */
	}

	var apiURL = url.resolve(this.wikis[wiki].parsoid, prefix + '/' + encodeURIComponent(title));
	if (revid) {
		apiURL += '?oldid=' + revid;
	}
	request({ url: apiURL, encoding: 'utf8', pool: false, log: this.log }, function(error, response, body) {
		if (error || response.statusCode !== 200) {
			deferred.reject("Error fetching Parsoid result: " + apiURL);
		} else {
			deferred.resolve(body);
		}
	});
	return result;
};

var parse = function(siteinfo, wiki, wikitext, title, status) {
	wiki = wiki || 0;
	var prefix = this.wikis[wiki].prefix;

	return new Promise(function(resolve, reject) {
		if (status) {
			status.report(null, util.format(
				'%s:<custom wikitext> [Parsoid]', prefix
			));
		}

		var apiURL = url.resolve(this.wikis[wiki].parsoid, prefix + '/' + title);
		request({
			url: apiURL,
			method: 'POST',
			encoding: 'utf8',
			pool: false,
			log: this.log,
			form: { wt: wikitext, body: true }
		}, function(error, response, body) {
			if (error || response.statusCode !== 200) {
				reject("Error fetching Parsoid result: " + apiURL);
			} else {
				resolve(body);
			}
		});
	}.bind(this)).then(function(text) {
		return new ParsoidResult(this, siteinfo, wiki, title, text);
	}.bind(this));
};

// We limit the number of parallel fetches allowed to be 'in flight'
Parsoid.prototype.fetch = Promise.guard(PARSOID_REQUEST_LIMIT, fetch);
Parsoid.prototype.parse = Promise.guard(PARSOID_REQUEST_LIMIT, parse);
