// Generate content of revisions-1.txt
// this is a particularly grody file, so we also store this in a more
// sane manner as revisions.db.  hopefully we can deprecate the ugliness.
"use strict";
require('core-js/shim');
var Promise = require('prfun');

var fs = require('fs');
var path = require('path');

var Api = require('./api');
var Db = require('./db');
var P = require('./p');

// limit the # of concurrent image requests
var REVISION_REQUEST_LIMIT = 5;

var Revisions = module.exports = function(wikis, log) {
	this.wikis = wikis;
	this.api = new Api(wikis, log);
	this.log = log || console.error.bind(console);
};

Revisions.prototype.fetchOne = function(wiki, title, revid) {
	var q = {
		action: 'query',
		prop: 'revisions',
		rvprop: 'content|ids',
		rvexpandtemplates: ''
	};
	if (revid) {
		q.revids = '' + revid;
	} else {
		q.titles = title;
		q.redirects = '';
	}
	return this.api.request(wiki, q).then(function(resp) {
		resp = resp.query.pages;
		var pageid = Object.keys(resp)[0];
		resp = resp[pageid];
		if ('missing' in resp) {
			// look in commons
			var nwiki = this.wikis.findIndex(function(w) {
				return w.prefix === 'commonswiki';
			});
			if (nwiki >= 0 && nwiki !== wiki) {
				return this.fetchOne(nwiki, title, revid);
			}
			this.log('ERROR: Revision not found for', title);
			return null;
		}
		resp.expanded = 1;
		resp.wiki = wiki;
		return resp;
	}.bind(this));
};

var writeOne = function(data, outstream, db, options) {
	// write db record
	// the key is a bit hacky, but revision id is not unique across
	// multiple wikis and neither is title alone.
	var key = (data.wiki ? (data.wiki + '|') : '') + data.revid;
	var contents = JSON.stringify(data);
	options.incrSize(contents);
	var p = db.put(key, contents);
	if (!outstream) {
		return p;
	}
	// append to revisions-1.txt stream
	var s =
		"\n\f --page-- " +
		JSON.stringify({
			expanded: data.expanded,
			ns: data.ns,
			revid: data.revid,
			title: data.title,
			wiki: data.wiki // our extension
		}) +
		'\n';
	p = p.then(function() {
		options.incrSize(s);
		return P.call(outstream.write, outstream, s, 'utf8');
	});
	p = p.then(function() {
		options.incrSize(data.revisions[0]['*']);
		return P.call(outstream.write, outstream,
					  data.revisions[0]['*'], 'utf8');
	});
	return p;
};

// fetch and write revision info corresponding to the given array of titles
Revisions.prototype.fetchAndWrite = function(titles, outdir, status, options) {
	var pediapress_compat = options.compat;
	var revDb = new Db(path.join(outdir, 'revisions.db'));
	var revStream = pediapress_compat ?
		fs.createWriteStream(path.join(outdir, 'revisions-1.txt')) :
		null;

	var fetchAndWriteOne = Promise.guard(REVISION_REQUEST_LIMIT, function(t) {
		status.report(null, this.wikis[t.wiki].prefix + ':' + t.title);
		return this.fetchOne(t.wiki, t.canontitle || t.title, t.revid).
			then(function(data) {
				return data===null ? null : writeOne(data, revStream, revDb, options);
			});
	}).bind(this);

	return Promise.all(titles.map(fetchAndWriteOne)).then(function() {
		return revDb.close();
	}).then(function() {
		return (revStream===null) ? null :
			P.call(revStream.end, revStream);
	});
};
