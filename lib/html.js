// Generate contents of html.db
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var util = require('util');

// Limit the # of concurrent requests to the HTML parser.
var PARSER_REQUEST_LIMIT = 5;

var Api = require('./api');
var P = require('./p');

var Html = module.exports = function(wikis, log) {
	var api = new Api(wikis, log);
	// Limit concurrency of API requests.
	this.request = Promise.guard(
		PARSER_REQUEST_LIMIT, api.request.bind(api)
	);
	this.wikis = wikis;
};

Html.prototype.fetch = function(wiki, title, revid /* Optional */, status /* Optional */) {
	wiki = wiki || 0;
	if (status) {
		// This is inside the guard, so if we launch lots of fetches in
		// parallel, we won't report them all at once.
		status.report(null, util.format(
			'%s:%s [PHP, %s]', this.wikis[wiki].prefix, title,
			revid ? ('revision ' + revid) : 'latest revision'
		));
	}
	var q = {
		action: 'parse',
		redirects: '',
	};
	if (revid) {
		q.oldid = revid;
	} else {
		q.title = title;
	}
	return this.request(wiki, q).then(function(result) {
		return result.parse;
	});
};
