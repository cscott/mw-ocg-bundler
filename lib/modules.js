// Fetch css and js modules for the articles
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var Api = require('./api');

var rrequest = Promise.promisify(require('./retry-request'), true);

// Limit the # of concurrent module requests.
var MODULE_REQUEST_LIMIT = 5;

var Modules = module.exports = function(wikis, log) {
	this.wikis = wikis;
	this.api = new Api(wikis, log);
	this.log = log || console.error.bind(console);
};

// Returns a promise for the metadata of modules
Modules.prototype.fetchdata =
Promise.guard(MODULE_REQUEST_LIMIT, function(module, page, oldid) {
	return this.api.request(module.wiki, {
		action: 'parse',
		prop: 'modules|jsconfigvars',
		page: page,
		oldid: oldid,
	}).then(function(resp) {
		resp = resp.parse.modules;
		var pageid = Object.keys(resp)[0];
		resp = resp[pageid];
		return resp;
	});
});

