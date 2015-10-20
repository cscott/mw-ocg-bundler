'use strict';
require('core-js/shim'); // Map/Set/Promise support
var Promise = require('prfun');

var json = require('../package.json');

var fs = require('fs');
var path = require('path');
var rimraf = require('rimraf');
var util = require('util');

var Attribution = require('./attribution');
var Authors = require('./authors');
var Db = require('./db');
var Html = require('./html');
var Image = require('./image');
var Metabook = require('./metabook');
var P = require('./p');
var Parsoid = require('./parsoid');
var Revisions = require('./revisions');
var SiteInfo = require('./siteinfo');
var StatusReporter = require('./status');
var Modules = require('./modules');

// Set this to true to emit bundles which are more closely compatible
// with the pediapress bundler (at the cost of poorer support for
// interwiki collections).
var IMAGEDB_COMPAT = Image.COMPAT_FILENAMES = false;
// Limit the total number of redirects we are willing to follow.
var MAX_REDIRECTS = 5;

module.exports = {
	name: json.name, // Package name.
	version: json.version, // Version # for this package.
};

// Allow access to the metabook creation/repair functions.
module.exports.metabook = Metabook;
// Allow access to the Parsoid/RESTBase download functions.
module.exports.parsoid = Parsoid;
// Allow access to SiteInfo (this caches site information).
module.exports.siteinfo = SiteInfo;

// Returns a promise to create the given bundle, which resolves with no
// value when the bundle is created successfully.
// The promise is rejected (with an object containing a non-zero `exitCode`
// property) if there is a problem creating the bundle.
module.exports.bundle = function(metabook, options) {
	var stages = 5;
	if (options.compat) { stages += 1; /* Add fetchRevisions stage. */ }
	var status = options.status = new StatusReporter(stages, function(msg) {
		if (options.log) {
			var file = msg.file ? (': ' + msg.file) : '';
			options.log('[' + msg.percent.toFixed() + '%]', msg.message + file);
		}
	});
	// Limit size of bundle.
	options.incrSize = (function() {
		var bundleSize = 0, imageSize = 0;
		return function(size, isImage) {
			if (typeof (size) === 'string') {
				size = (new Buffer(size, 'utf8')).length;
			}
			console.assert(typeof (size) === 'number', typeof (size));
			if (isImage) {
				// Image size limit is soft.
				imageSize += size;
				if (options.imageSizeLimit !== 0 &&
					imageSize > options.imageSizeLimit) {
					imageSize -= size;
					return false; // Don't add this image.
				}
			}
			bundleSize += size;
			if (options.bundleSizeLimit !== 0 &&
				bundleSize > options.bundleSizeLimit) {
				var err = new Error('Bundle size limit exceeded: ' + bundleSize + '/' + options.bundleSizeLimit);
				err.exitCode = 2;
				throw err;
			}
			return bundleSize || true; // Make sure result is truthy.
		};
	})();

	var parsoid = new Parsoid(metabook.wikis, options.apiVersion, options.log);
	var authors = new Authors(metabook.wikis, options.log);
	var modules = new Modules(metabook.wikis, options.log);
	var html = new Html(metabook.wikis, options.log);
	var imageloader = new Image(metabook.wikis, options.log);
	var revisions = new Revisions(metabook.wikis, options.log);
	var siteinfo = new SiteInfo(metabook.wikis, options.log);

	var attribution = new Attribution(parsoid, siteinfo, options.log);

	var sourceMap = new Map(), imageMap = new Map();

	var cleanUpOutput = false;

	var mkOutputDir = function() {
		// Fail if output location is not writable.
		return P.call(fs.mkdir, fs, options.output, parseInt('700', 8)).then(function() {
			// Don't clean up output dir unless this mkdir succeeded.
			cleanUpOutput = true;
		});
	};

	var parsoidDb, authorsDb, imageDb, htmlDb, modulesDb;
	var openDatabases = function() {
		parsoidDb = new Db(path.join(options.output, 'parsoid.db'));
		authorsDb = new Db(path.join(options.output, 'authors.db'));
		imageDb = new Db(path.join(options.output, 'imageinfo.db'));
		htmlDb = options.compat ? new Db(path.join(options.output, 'html.db')) : null;
		modulesDb =  options.fetchModules ? new Db(path.join(options.output, 'modules.db')) : null;
	};

	var closeDatabases = function() {
		return Promise.map([parsoidDb, authorsDb, imageDb, htmlDb, modulesDb], function(db) {
			if (db) {
				return db.close().catch(function(e) { /* Ignore */ });
			}
		});
	};

	// Promise to have written a file.
	var writeFile = Promise.method(function(filename, contents, options) {
		options.incrSize(contents);
		return P.call(
			fs.writeFile, fs,
			path.join(options.output, filename),
			contents, { encoding: 'utf8' }
		);
	});
	// Promise to have written a DB key.
	var dbPut = Promise.method(function(db, key, value, options) {
		if (typeof (value) !== 'string') { value = JSON.stringify(value); }
		options.incrSize(value);
		return db.put(key, value);
	});

	// Promise to repair metabook.
	var repairMetabook = function() {
		return Metabook.repair(metabook, siteinfo, options).then(function(m) {
			metabook = m;
		});
	};

	// Promise to fetch and write siteinfo.
	var fetchSiteInfo = function() {
		return siteinfo.fetchAndWrite(options);
	};

	// Count total # of items (used for status reporting).
	var countItems = function(item) {
		return (item.items || []).reduce(function(sum, item) {
			return sum + countItems(item);
		}, 1);
	};

	// Returns a promise which is resolved when the sourceMap has been
	// filled with all the parsoid sources.
	var fetchParsed = function() {
		status.createStage(
			// 4 Tasks per item, fetch parsoid, fetch php, fetch metadata, mark complete
			4 * countItems(metabook),
			'Fetching parsed articles'
		);

		var maxRedirects = options.follow ? MAX_REDIRECTS : 0;

		var tasks = [];
		// A promise to parse a single item (from parsoid & php).
		var doOneItem = function(item, redirect) {
			item.wiki = item.wiki || 0;
			// Note that item revision is not a unique key in a multiwiki
			// collection. so we prefix it by the wiki index in that case.
			var key = item.wiki ? (item.wiki + '|') : '';
			var redirectTitle;
			return siteinfo.fetch(item.wiki).then(function(si) {
				return parsoid.fetch(
					si, item.wiki, item.title, item.revision,
					options.saveRedirects ? 0 : maxRedirects,
					status
				);
			}).then(function(result) {
				item.about = result.getAbout(); // RDF 'about' property
				item.isVersionOf = result.getIsVersionOf(); // RDF 'isVersionOf'
				var revid = result.getRevisionId();
				if (!revid) { throw new Error('No revision ID'); }
				item.revision = '' + revid;
				sourceMap.set(revid, result);
				result.getImages().forEach(function(img) {
					// XXX this stores metadata for all images in memory.
					// for very large bundles, store in temp db?
					imageMap.set(img.resource, img);
				});
				key += item.revision;
				redirectTitle = result.getRedirect();
				return dbPut(parsoidDb, key, result.text, options);
			}).then(function() {
				return options.compat ? html.fetch(item.wiki, item.title, item.revision, status) : null;
			}).then(function(result) {
				return options.compat ? dbPut(htmlDb, key, result, options) : null;
			}).then(function() {
				return options.fetchModules ? modules.fetchData(item.wiki, item.title, item.revision) : null;
			}).then(function(result) {
				return options.fetchModules ? dbPut(modulesDb, key, result, options) : null;
			}).then(function() {
				// TODO: these queries should probably be batched
				return authors.fetchMetadata(item.wiki, item.title, item.revision, status).then(function(result) {
					dbPut(
						authorsDb,
						item.wiki ? (item.wiki + '|' + item.title) : item.title,
						JSON.stringify(result),
						options
					);
				});
			}).then(function() {
				// Was this a redirect?  If so, repeat from the start!
				if (options.saveRedirects && redirect > 0 && redirectTitle) {
					// Destructively update the item w/ the 'real' title.
					item.title = redirectTitle;
					item.revision = null;
					// Loop.
					return doOneItem(item, redirect - 1);
				}
				status.report(null, util.format(
					'%s:%s [complete]',
					metabook.wikis[item.wiki].prefix, item.title
				));
			});
		};

		// Recursively visit all items in the metabook info structure.
		(function visit(item) {
			if (item.type === 'article') {
				tasks.push(doOneItem(item, maxRedirects));
			} else {
				status.reportN(3, null, item.type + ' ' + item.title);
				(item.items || []).forEach(visit);
			}
		})(metabook);

		// Return a promise to do all these tasks.
		return Promise.all(tasks);
	};

	var imagedir = path.join(options.output, 'images');

	var mkImageDir = function() {
		return P.call(fs.mkdir, fs, imagedir, parseInt('777', 8));
	};

	// Returns a promise which is resolved when all images from the imageMap
	// are downloaded.
	var fetchImages = function() {
		status.createStage(2 * imageMap.size, 'Fetching media');

		var tasks = [];
		imageMap.forEach(function(img) {
			var p = imageloader.fetchMetadata(img, status).then(function() {
				if (img.missing) {
					status.report(null, img.short + ' [missing]');
				} else if (
					img.imageinfo.mediatype === 'BITMAP' ||
					img.imageinfo.mediatype === 'DRAWING' ||
					img.imageinfo.mediatype === 'VIDEO' ||
					img.imageinfo.mime === 'application/pdf'
				) {
					var osize = img.imageinfo.size;
					if (options.incrSize(osize, 'image') === false) {
						status.report(null, img.short + ' [skipping, image too large]');
					} else {
						return imageloader.fetch(img, imagedir, status).
							then(function() {
								// Correct size, if changed.
								options.incrSize(img.imageinfo.size - osize, 'image');
							});
					}
				} else {
					status.report(null, img.short + ' [skipping]');
				}
			}).then(function() {
				var metadata = {
					height: img.imageinfo.height,
					width: img.imageinfo.width,
					thumburl: img.src,
					url: img.imageinfo.url,
					descriptionurl: img.imageinfo.descriptionurl,
					sha1: img.imageinfo.sha1,
					// Our extensions:
					resource: img.resource,
					short: img.short,
					mime: img.imageinfo.mime,
					mediatype: img.imageinfo.mediatype,
					filename: img.filename,
					size: img.imageinfo.size,
				};
				if (img.missing) {
					metadata.missing = true;
				}
				['Artist', 'Credit', 'LicenseShortName', 'AttributionRequired', 'Copyrighted'].forEach(function(k) {
					var md = img.imageinfo.extmetadata;
					if (md && md[k] && md[k].value) {
						metadata[k.toLowerCase()] = md[k].value;
					}
				});
				var key = IMAGEDB_COMPAT ? img.short : img.resource;
				return dbPut(imageDb, key, metadata, options);
			});
			tasks.push(p);
		});

		// Return a promise to do all these tasks.
		return Promise.all(tasks);
	};

	var moduledir = path.join(options.output, 'modules');

	var mkModuleDir = function() {
		return options.fetchModules ? P.call(fs.mkdir, fs, moduledir, parseInt('777', 8)) : null;
	};

	var fetchRevisions = function() {
		// Create list of titles to fetch.
		var titles = [];
		//  ... all articles
		sourceMap.forEach(function(parsoidResult, revid) {
			titles.push({
				wiki: parsoidResult.wiki,
				title: parsoidResult.title,
				revid: revid,
			});
		});
		//  ... all image pages
		imageMap.forEach(function(img) {
			// Look up appropriate wiki (may fetch from commons).
			var w = metabook.wikis[img.wiki], iwiki = img.wiki;
			w.filerepos.forEach(function(repo) {
				if (img.imagerepository === repo.name) {
					iwiki = repo.wiki;
				}
			});
			// Normalize namespace (localized namespaces don't work on commons).
			var canontitle = img.short.replace(/^[^:]+:/, 'File:');
			titles.push({
				wiki: iwiki,
				title: img.short,
				canontitle: canontitle,
				// Images are always the 'latest' revision.
			});
		});
		status.createStage(titles.length, 'Fetching wikitext');
		return revisions.fetchAndWrite(
			titles, options.output, status, options
		);
	};

	var writeAttribution = function() {

		return attribution.process(
			metabook, authorsDb, imageDb, status
		).then(function(result) {
			// Write the output.
			return Promise.join(
				writeFile('attribution.html', result.rdf, options),
				options.compat ?
					writeFile('attribution.wt', result.wikitext, options) : null
			);
		});
	};

	var writeMetabookNfoJson = function() {
		// Poor man's clone/
		var nfo = JSON.parse(JSON.stringify(metabook.wikis[0]));
		// Field names in the nfo file differ slightly =(
		nfo.base_url = nfo.baseurl;
		delete nfo.baseurl;
		// Write to disk.
		return Promise.join(
			writeFile('metabook.json', JSON.stringify(metabook), options),
			options.compat ? writeFile('nfo.json', JSON.stringify(nfo), options) : null
		);
	};

	// Promise to sync the various directories.
	// Closing a file does *not* guarantee that the file's metadata (size, etc)
	// will be flushed to its containing directory.  That can confuse
	// zip!  So let's ensure that the directories are all synced.
	var syncOutputDirs = function() {
		var syncDir = function(path) {
			return P.call(fs.open, fs, path, 'r').then(function(fd) {
				return P.call(fs.fsync, fs, fd).then(function() {
					return P.call(fs.close, fs, fd);
				});
			});
		};
		return syncDir(imagedir).then(function() {
			return syncDir(options.output);
		});
	};

	// Promise to create the desired bundle!
	var createBundle = function() {
		status.createStage(0, 'Creating bundle');
		if (options.nozip) {
			// Make the directory readable, then we're done.
			return P.call(fs.chmod, fs, options.output, parseInt('755', 8));
		}

		// Create zip archive.
		var tmpzip = options.output + '.tmp';
		var params = [ '-q', '-r', path.resolve(tmpzip), '.' ];
		if (options.storedb) {
			// Don't compress sqlite3 files.  This allows them to be
			// accessed directly within the .db without extraction.
			params.unshift('-n', '.db');
		}
		var p = P.spawn('zip', params, {
			childOptions: { cwd: options.output },
		});

		// Always clean up at the end.
		p = p.finally(function() {
			try {
				rimraf.sync(options.output, { disableGlob: true });
				fs.renameSync(tmpzip, options.output);
			} catch (e1) { /* Ignore */ }
			try {
				rimraf.sync(tmpzip, { disableGlob: true });
			} catch (e2) { /* Ignore */ }
		});
		return p;
	};

	return Promise.resolve()
	// Stage 1
		.then(function() {
			status.createStage(
				2 * (metabook.wikis.length + 1),
				'Fetching wiki configuration'
			);
		})
		.then(repairMetabook)
		.then(mkOutputDir)
		.then(mkModuleDir)
		.then(openDatabases)
		.then(fetchSiteInfo)
	// Stage 2
		.then(fetchParsed)
	// Stage 3
		.then(mkImageDir)
		.then(fetchImages)
	// Stage 4
		.then(options.compat ? fetchRevisions : function() {})
	// Stage 5
		.then(writeAttribution)
		.then(writeMetabookNfoJson)
	// Stage 6
		.finally(closeDatabases)
		.then(syncOutputDirs)
		.then(createBundle)
		.then(function() {
			var size = options.incrSize(0);
			status.createStage(0, 'Done', util.format('(%d bytes)', size));
			return;
		}, function(err) {
			// Clean up.
			if (cleanUpOutput) {
				try {
					rimraf.sync(options.output, { disableGlob: true });
				} catch (e) { /* Ignore */ }
			}
			// XXX Use different values to distinguish failure types?
			if (!err.exitCode) {
				// Some error objects are read-only; don't crash if so.
				try { err.exitCode = 1; } catch (e) { /* Ignore. */ }
			}
			throw err;
		});
};
