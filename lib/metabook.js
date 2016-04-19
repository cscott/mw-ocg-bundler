/** Create a new metabook structure, or fixup a broken/incomplete one. */
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var url = require('url');

var Api = require('./api');
var P = require('./p');
var Parsoid = require('./parsoid');
var SiteInfo = require('./siteinfo');

var DEFAULT_IMAGESIZE = 1200; // 1200 Pixels = 300dpi * 4" wide image.

var DEFAULT_METABOOK = {
	type: 'collection',
	title: '',
	subtitle: '',
	summary: '',
	version: 1,
	items: [],
	licenses: [ {
		mw_rights_icon: '',
		mw_rights_page: '',
		mw_rights_text: '',
		mw_rights_url: '',
		name: 'License',
		type: 'license',
	}, ],
	wikis: [{
		type: 'wikiconf',
		baseurl: null, // API endpoint for the wiki, filled in below
		imagesize: DEFAULT_IMAGESIZE,
		keep_tmpfiles: false,
		script_extension: '.php',
		format: 'nuwiki',
		// Our extra fields (filled in below).
		restbase1: undefined,
		parsoid: undefined,
		prefix: undefined,
		// The filerepos is a link to commons, etc; it looks something like:
		filerepos: [{
			type: 'filerepo',
			name: 'local',
			displayname: 'Wikimedia Commons',
			rootUrl: '//upload.wikimedia.org/wikipedia/commons',
			local: true,
			scriptDirUrl: 'https://commons.wikimedia.org/w/api.php',
			wiki: 0, // Pointer to an entry in metabook.wikis
		},],
	},],
};

var COMMONSWIKI = {
	type: 'wikiconf',
	baseurl: 'https://commons.wikimedia.org/w',
	imagesize: DEFAULT_IMAGESIZE,
	keep_tmpfiles: false,
	script_extension: '.php',
	format: 'nuwiki',
	// Our extra fields
	restbase1: 'https://commons.wikimedia.org/api/rest_v1/',
	parsoid: undefined,
	prefix: 'commonswiki',
	filerepos: undefined,
};

var clone = function(o) {
	// Poor man's clone.
	return JSON.parse(JSON.stringify(o));
};

// Helper: extract domain from a URL.
var extractDomain = function(u) {
	return url.parse(u, false, true).hostname;
};

var enSiteMatrixP; // Cache this value once fetched.

// Return a promise for a metabook object containing the given articles.
var metabookFromArticles = function(articles, options) {
	var metabook = clone(DEFAULT_METABOOK);
	metabook.wikis = [];

	// Fetch sitematrix from enwiki to get prefix mapping.
	if (!enSiteMatrixP) {
		enSiteMatrixP = new Api([{ baseurl: 'https://en.wikipedia.org/w' }]).
			request(0, { action: 'sitematrix' }).then(function(resp) {
				// Destructure and convert response object to a proper array.
				var sitematrix = [];
				for (var i = 0; resp.sitematrix[i]; i++) {
					resp.sitematrix[i].site.forEach(function(s) {
						sitematrix.push(s);
					});
				}
				resp.sitematrix.specials.forEach(function(s) {
					sitematrix.push(s);
				});
				// Now map prefix/domain to site information.
				var map = new Map();
				sitematrix.forEach(function(s) {
					map.set('P' + s.dbname, s);
					map.set('D' + extractDomain(s.url), s);
				});
				return map;
			});
	}
	var sitematrix;
	var p = enSiteMatrixP.then(function(sm) { sitematrix = sm; });

	// Look up prefix.
	var lookupCache = new Map();
	var lookup = function(prefix, domain) {
		// Check cache first -- is this prefix/domain already in the set of wikis?
		if (domain && lookupCache.has('D' + domain)) {
			return lookupCache.get('D' + domain);
		}
		if (prefix && lookupCache.has('P' + prefix)) {
			return lookupCache.get('P' + prefix);
		}
		// Now check the sitematrix.
		var s;
		if (!s && domain) {
			// Prefer restbase1/parsoid2
			s = sitematrix.get('D' + domain);
		}
		if (!s && prefix) {
			s = sitematrix.get('P' + prefix);
		}
		if (!s && options.phpApi) {
			s = {
				url: options.phpApi,
			};
		}
		if (!s) {
			if (prefix) {
				throw new Error('Prefix not found: ' + prefix);
			} else if (domain) {
				throw new Error('Domain not found: ' + domain);
			} else {
				throw new Error('No prefix or domain specified.');
			}
		}
		if (!prefix) {
			prefix = s.dbname;
		}
		if (!domain) {
			domain = extractDomain(s.url);
		}
		var baseurl = options.phpApi || url.resolve(s.url, '/w');
		var idx = metabook.wikis.length;
		metabook.wikis.push({
			type: 'wikiconf',
			baseurl: baseurl,
			imagesize: options.size || DEFAULT_IMAGESIZE,
			keep_tmpfiles: false,
			script_extension: '.php',
			format: 'nuwiki',
			restbase1: options.restbaseApi ||
				url.resolve(s.url, '/api/rest_v1/'),
			parsoid: options.parsoidApi ||
				'http://parsoid-lb.eqiad.wikimedia.org/',
			prefix: prefix,
			domain: domain,
			titleurl: url.resolve(s.url, '/wiki/') + '$1', // (Temporary)
		});
		lookupCache.set('P' + prefix, idx);
		lookupCache.set('D' + domain, idx);
		return idx;
	};

	// Fill in items
	return P.forEachSeq(articles, function(a) {
		var prefix = a.prefix, domain = a.domain, title = a.title;
		return Promise.resolve().then(function() {
			return lookup(prefix, domain);
		}).then(function(w) {
			var url = metabook.wikis[w].titleurl.replace(/\$1/, title);

			// XXX Fetch latest revision and timestamp?
			var item = {
				type: 'article',
				title: title.replace(/_/g,' '),
				content_type: 'text/x-wiki',
				url: url,
				wiki: w,
			};
			metabook.items.push(item);
		});
	}, p).then(function() {
		// Remove temporary titleurl info.
		metabook.wikis.forEach(function(w) {
			delete w.titleurl;
		});
		// Resolve to the resulting metabook object.
		return metabook;
	});
};

// Return a promise for a metabook from the given collection.
var metabookFromCollection = function(collection, options, log) {
	// First do the prefix-guessing, etc.
	return metabookFromArticles(
		[{ prefix: options.prefix, domain: options.domain, title: collection }],
		options
	).then(function(m) {
		// Use this to fetch the source of the collection page.
		var parsoid = new Parsoid(m.wikis, options.apiVersion, log);
		var siteinfo = new SiteInfo(m.wikis, log);
		return siteinfo.fetch(0).then(function(si) {
			return parsoid.fetch(si, 0, collection);
		});
	}).then(function(parsoidResult) {
		var doc = parsoidResult.document;
		// Remove ombox
		var ombox = doc.querySelector('.ombox');
		ombox.parentNode.removeChild(ombox);
		// FIXME: We're ignoring chapters, etc.
		var links = doc.querySelectorAll('a');
		var articles = [];
		for (var i = 0; i < links.length; i++) {
			// XXX: Doesn't handle multiwiki collections, should probably
			//      confirm rel="mw:WikiLink".
			var title = parsoidResult._resolve(links[i].getAttribute('href'));
			articles.push({
				prefix: options.prefix, domain: options.domain, title: title,
			});
		}
		return metabookFromArticles(articles, options);
	});
};

var metabookRepair = function(metabook, siteinfo, options) {
	var needsCommonsWiki = false;
	var status = options.status;
	var p = Promise.resolve();

	// Allow external use of this API w/o access to the SiteInfo module.
	siteinfo = siteinfo || new SiteInfo(metabook.wikis, options.log);

	// Promise to fetch missing 'filerepos' field in wiki config.
	var fetchFileRepos = function(wiki) {
		var api = new Api(metabook.wikis, options.log);
		var w = metabook.wikis[wiki];
		var p = Promise.resolve();
		if (!w.filerepos) {
			w.filerepos = [];
			p = p.then(function() {
				return api.request(wiki, {
					action: 'query',
					meta: 'filerepoinfo',
				});
			}).then(function(resp) {
				resp.query.repos.forEach(function(repo) {
					repo.type = 'filerepo';
					w.filerepos.push(repo);
					// Link to a wiki # in metabooks.json
					if (repo.local !== undefined) {
						repo.wiki = wiki;
						return;
					}
					// XXX Note that scriptDirUrl isn't (yet) part of the
					// filerepoinfo response.
					// See https://gerrit.wikimedia.org/r/96568
					if (!repo.scriptDirUrl) {
						repo.scriptDirUrl = COMMONSWIKI.baseurl;
					}
					for (var i = 0; i < metabook.wikis.length; i++) {
						if (metabook.wikis[i].baseurl === repo.scriptDirUrl) {
							repo.wiki = i;
							return;
						}
					}
					// Fudge a pointer to commons.
					needsCommonsWiki = true;
					repo.wiki = metabook.wikis.length;
				});
			});
		}
		return p;
	};
	// Add our extension fields, if missing.
	p = p.then(function() {
		var pp = Promise.resolve();
		if (options.toc !== 'auto') {
			metabook.toc = !/^(no|false|off)$/i.test(options.toc);
		}
		metabook.wikis.forEach(function(w, idx) {
			status.report(null, w.baseurl);
			if (!w.restbase1) {
				w.restbase1 = options.restbaseApi;
			}
			if (!w.parsoid) {
				w.parsoid = options.parsoidApi;
			}
			if (!w.prefix && !w.domain) {
				// Look up siteid in siteinfo.
				pp = pp.then(function() {
					return siteinfo.fetch(idx);
				}).then(function(resp) {
					w.prefix = resp.general.wikiid;
				});
			}
			if (!w.filerepos) {
				pp = pp.then(function() {
					return fetchFileRepos(idx);
				});
			}
		});
		return pp;
	});
	// Fudge a pointer to commonswiki if needed.
	p = p.then(function() {
		if (needsCommonsWiki) {
			status.report(null, COMMONSWIKI.baseurl);
			var cwiki = clone(COMMONSWIKI);
			cwiki.parsoid = options.parsoidApi;
			metabook.wikis.push(cwiki);
			return fetchFileRepos(metabook.wikis.length - 1);
		} else {
			status.report(null, ' ');
		}
	});
	// Override max image sizes, if requested.
	if (+options.size) {
		p = p.then(function() {
			metabook.wikis.forEach(function(w) {
				w.imagesize = +options.size;
			});
		});
	}
	// Add a default language for this collection (used for chapter titles,
	// etc); use the language of the first article if none was specified.
	p = p.then(function() {
		if (options.lang) {
			// CLI option overrides any other language setting
			metabook.lang = options.lang;
		}
		if (metabook.lang) {
			// `lang` already set, nothing more to do.
			return;
		}
		// Use the language from the first item.
		var first = metabook.items[0];
		if (!first) {
			// No first item, default to English.
			metabook.lang = 'en';
			return;
		}
		return siteinfo.fetch(first.wiki || 0).
			then(function(siteinfo) {
				// Use the language specified in the siteinfo.
				metabook.lang = siteinfo.general.lang || 'en';
			});
	});
	// Done!
	return p.then(function() {
		return metabook;
	});
};

module.exports = {
	DEFAULT_IMAGESIZE: DEFAULT_IMAGESIZE,
	fromArticles: metabookFromArticles,
	fromCollection: metabookFromCollection,
	repair: metabookRepair,
};
