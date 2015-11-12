// Make concurrency-limited parsoid API requests.
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var domino = require('domino');
var fs = require('fs');
var headers = require('./headers');
var path = require('path');
var request = require('./retry-request');
var url = require('url');
var util = require('util');

var P = require('./p');
var SiteInfo = require('./siteinfo');

// Limit the # of concurrent requests to parsoid.
var PARSOID_REQUEST_LIMIT = 5;

// Escape special regexp characters in a string.
// Used to build a regexp matching a literal string.
var escapeRegExp = function(s) {
	return s.replace(/[\^\\$*+?.()|{}\[\]\/]/g, '\\$&');
};

var Parsoid = module.exports = function(wikis, apiVersion, log) {
	this.wikis = wikis;
	this.apiVersion = apiVersion;
	this.log = log;
};

var ParsoidResult = function(parsoid, siteinfo, wiki, title, text) {
	this.wiki = wiki;
	this.title = title;
	this.text = text;
	this.imagesize = parsoid.wikis[wiki].imagesize;
	this.document = domino.createDocument(text);
	// Create a regexp that matches the article path in order to resolve URLs
	// into titles.
	var m = /^([\s\S]*)\$1([\s\S]*)$/.exec(siteinfo.general.articlepath);
	this._resolveRE = new RegExp(
		'^' + escapeRegExp(m[1]) + '([\\s\\S]*)' + escapeRegExp(m[2]) + '$'
	);
};

// Resolve an article title.
ParsoidResult.prototype._resolve = function(href) {
	var path = url.parse(url.resolve(this.getBaseHref(), href), false, true).
		pathname;
	// Now remove the articlepath.
	var m = this._resolveRE.exec(path);
	if (!m) { throw new Error('Bad article title: ' + href); }
	return decodeURIComponent(m[1]);
};

ParsoidResult.prototype.getRedirect = function() {
	var redirect = this.document.querySelector(
		'link[rel="mw:PageProp/redirect"][href]'
	);
	if (redirect) {
		return this._resolve(redirect.getAttribute('href'));
	}
	return null; // No redirect.
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
		'*[typeof="mw:Image/Thumb"] > * > img[resource]',
	].join(','));
	return Array.prototype.map.call(imgs, function(img) {
		var relResourceURL = img.getAttribute('resource');
		var resourceURL = url.resolve(base, relResourceURL);
		var srcURL = url.resolve(base, img.getAttribute('src')); // Thumb, etc
		return {
			wiki: this.wiki,
			short: this._resolve(relResourceURL),
			resource: resourceURL,
			src: srcURL,
			imagesize: this.imagesize,
		};
	}.bind(this));
};

var findApiUrl = function(method, apiVersion, wiki, title, revid) {
	var apiURL;
	var domain = wiki.domain ||
		(wiki.baseurl && url.parse(wiki.baseurl, false, true).hostname);
	apiVersion = apiVersion || 'auto';
	if (apiVersion === 'auto') {
		if (wiki.restbase1) {
			// Prefer to fetch from restbase.
			apiVersion = 'restbase1';
		} else if (domain && wiki.parsoid) {
			apiVersion = 'parsoid3';
		} else if (wiki.prefix && wiki.parsoid) {
			apiVersion = 'parsoid1'; // Deprecated.
		} else {
			// Make a restbase url from the baseurl.
			apiVersion = 'restbase1';
		}
	}
	if (apiVersion === 'restbase1' || apiVersion === 'parsoid3') {
		// Restbase v1 / Parsoid v3
		if (apiVersion === 'restbase1') {
			console.assert(wiki.restbase1 || wiki.baseurl, 'Bad restbase1 configuration.');
			apiURL = wiki.restbase1 ||
				url.resolve(wiki.baseurl, '/api/rest_v1/');
		} else if (apiVersion === 'parsoid3') {
			console.assert(wiki.parsoid && domain, 'Bad parsoid3 configuration.');
			apiURL = url.resolve(wiki.parsoid, '/' + domain + '/v3/');
		}
		if (!/\/$/.test(apiURL)) { apiURL += '/'; /* Ensure slash at end. */ }
		if (method === 'POST') {
			apiURL = url.resolve(apiURL, './transform/wikitext/to/html/');
		} else {
			apiURL = url.resolve(apiURL, './page/html/');
		}
		apiURL += encodeURIComponent(title); /* Encode slashes. */
		if (revid) {
			apiURL += '/' + revid;
		}
	} else if (apiVersion === 'parsoid1') {
		// Parsoid v1 (deprecated)
		console.assert(wiki.parsoid && wiki.prefix, 'Bad parsoid1 configuration.');
		apiURL = url.resolve(wiki.parsoid, wiki.prefix + '/' + encodeURIComponent(title));
		if (revid) {
			apiURL += '?oldid=' + revid;
		}
	} else if (apiVersion === 'parsoid2') {
		// Parsoid v2 (deprecated)
		// Get the domain from the baseURL.
		console.assert(wiki.parsoid && domain, 'Bad parsoid2 configuration.');
		apiURL = url.resolve(wiki.parsoid, '/v2/' + domain + '/html/');
		apiURL += encodeURIComponent(title); /* Encode slashes. */
		if (revid) {
			apiURL += '/' + revid;
		}
	} else {
		// Treat any other value as if it is "auto".
		return findApiUrl(method, 'auto', wiki, title, revid);
	}
	// Default to https if URL is protocol-relative.
	if (/^\/\//.test(apiURL)) { apiURL = 'https:' + apiURL; }
	return { api: apiVersion, url: apiURL };
};

var fetch = function(siteinfo, wiki, title, revid /* Optional */, maxRedirects /* Optional */, status /* Optional */) {
	wiki = wiki || 0;
	maxRedirects = maxRedirects || 0;
	// Allow external use of this API w/o access to the SiteInfo module.
	if (!siteinfo) {
		return new SiteInfo(this.wikis, this.log).fetch(wiki).then(function(si) {
			return this.fetch(si, wiki, title, revid, maxRedirects, status);
		}.bind(this));
	}

	var prefix = this.wikis[wiki].prefix;
	if (status) {
		// This is inside the guard, so if we launch lots of fetches in
		// parallel, we won't report them all at once.
		status.report(null, util.format(
			'%s:%s [Parsoid, %s]', prefix, title,
			revid ? ('revision ' + revid) : 'latest revision'
		));
	}
	var deferred = Promise.defer();
	var result = deferred.promise.then(function(text) {
		// Parse the article text.
		var pr = new ParsoidResult(this, siteinfo, wiki, title, text);
		// Check for redirects.
		var ntitle = pr.getRedirect();
		if (ntitle && maxRedirects > 0) {
			// Use unguarded version of this method, so we don't end up
			// deadlocking if maxRedirects > PARSOID_REQUEST_LIMIT.
			return fetch.call(this, siteinfo, wiki, ntitle, null, maxRedirects - 1, null);
		}
		return pr;
	}.bind(this));

	// Look-aside cache, mostly for quicker/offline dev.
	try {
		var cachePath = path.join(__dirname, '..', 'cache', prefix, title);
		if (revid) { cachePath = path.join(cachePath, '' + revid); }
		var cached = fs.readFileSync(cachePath, 'utf8');
		deferred.resolve(cached);
		return result;
	} catch (e) {
		/* No cached version, do the actual API request. */
	}

	var apiURL = findApiUrl('GET', this.apiVersion, this.wikis[wiki], title, revid);
	request({ url: apiURL.url, encoding: 'utf8', headers: headers, pool: false, log: this.log }, function(error, response, body) {
		if (error || response.statusCode !== 200) {
			deferred.reject(new Error('Error fetching ' + apiURL.api + ' result: ' + apiURL.url + ' ' + (error || response.statusCode)));
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

		var apiURL = findApiUrl('POST', this.apiVersion, this.wikis[wiki], title);
		request({
			url: apiURL.url,
			method: 'POST',
			encoding: 'utf8',
			headers: headers,
			pool: false,
			log: this.log,
			form: (
				apiURL.api === 'parsoid1' ? { wt: wikitext, body: true } :
				apiURL.api === 'parsoid2' ? { wikitext: wikitext, body: true } :
				{ wikitext: wikitext, body_only: true }
			),
		}, function(error, response, body) {
			if (error || response.statusCode !== 200) {
				reject(new Error('Error fetching ' + apiURL.api + ' result: ' + apiURL.url + ' ' + (error || response.statusCode)));
			} else {
				resolve(body);
			}
		});
	}.bind(this)).then(function(text) {
		return new ParsoidResult(this, siteinfo, wiki, title, text);
	}.bind(this));
};

// We limit the number of parallel fetches allowed to be "in flight".
Parsoid.prototype.fetch = Promise.guard(PARSOID_REQUEST_LIMIT, fetch);
Parsoid.prototype.parse = Promise.guard(PARSOID_REQUEST_LIMIT, parse);
