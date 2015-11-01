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
Modules.prototype.fetchData =
Promise.guard(MODULE_REQUEST_LIMIT, function(wiki, title, revision) {
	return this.api.request(wiki, {
		action: 'parse',
		prop: 'modules|jsconfigvars',
		page: title,
		oldid: revision,
	}).then(function(resp) {
		resp = resp.parse;
		// Trim down the size of the response by omitting redundant fields.
		return {
			modules: resp.modules,
			modulescripts: resp.modulescripts,
			modulestyles: resp.modulestyles,
			jsconfigvars: resp.jsconfigvars,
		};
	});
});
