require('es6-shim'); // Map/Set support

var archiver = require('archiver');
var fs = require('fs');
var nodefn = require("when/node/function");
var path = require('path');
var rimraf = require('rimraf');
var when = require('when');

// my own version of nodefn.call with an explicit 'this', used for methods
var pcall = function(fn, self) {
	var args = Array.prototype.slice.call(arguments, 2);
	return nodefn.apply(fn.bind(self), args);
};

module.exports = {
	version: require('../package.json').version
};

// returns a promise to create the given bundle
module.exports.bundle = function(metabook, nfo, options) {
	var Parsoid = require('./parsoid');
	var Html = require('./html');
	var Image = require('./image');
	var Db = require('./db');
	var Revisions = require('./revisions');
	var Siteinfo = require('./siteinfo');

	var log = function() {
		if (options.verbose || options.debug) {
			console.error.apply(console, arguments);
		}
	};

	var parsoid = new Parsoid(metabook.wikis, log);
	var html = new Html(metabook.wikis, log);
	var imageloader = new Image(metabook.wikis, log);

	var sourceMap = new Map(), imageMap = new Map();

	var cleanUpOutput = false;

	var mkOutputDir = function() {
		// fail if output location is not writable
		return pcall(fs.mkdir, fs, options.output, 0700).then(function() {
			// don't clean up output dir unless this mkdir succeeded
			cleanUpOutput = true;
		});
	};

	// promise to fetch and write siteinfo
	var fetchSiteinfo = function() {
		return Siteinfo.fetchAndWrite(metabook.wikis, options.output);
	};

	// returns a promise which is resolved when the sourceMap has been
	// filled with all the parsoid sources.
	var fetchParsed = function() {
		log('Fetching parsed article contents');
		var parsoidDb = new Db(path.join(options.output, "parsoid.db"));
		var htmlDb = new Db(path.join(options.output, "html.db"));

		var tasks = [];
		// a promise to parse a single item (from parsoid & php)
		var doOneItem = function(item) {
			item.wiki = item.wiki || 0;
			return parsoid.fetch(item.wiki, item.title, item.revision)
				.then(function(result) {
					var revid = result.getRevisionId();
					if (!revid) { throw new Error("No revision ID"); }
					item.revision = '' + revid;
					sourceMap.set(revid, result);
					result.getImages().forEach(function(img) {
						imageMap.set(img.resource, img);
					});
					return parsoidDb.put(item.revision, result.text);
				}).then(function() {
					return html.fetch(item.wiki, item.title, item.revision);
				}).then(function(result) {
					return htmlDb.put(item.revision, result);
				});
		};

		// recursively visit all items in the metabook info structure
		(function visit(item) {
			if (item.type === 'article') {
				tasks.push(doOneItem(item));
			} else if (item.type === 'collection' || item.type === 'chapter') {
				item.items.forEach(visit);
			}
		})(metabook);

		// return a promise to do all these tasks, then close the parsoid db
		return when.all(tasks).then(function() {
			return parsoidDb.close();
		}).then(function() {
			return htmlDb.close();
		});
	};

	var imagedir = path.join(options.output, 'images');

	var mkImageDir = function() {
		return pcall(fs.mkdir, fs, imagedir, 0777);
	};

	// returns a promise which is resolved when all images from the imageMap
	// are downloaded.
	var fetchImages = function() {
		log('Fetching images');
		var imageDb = new Db(path.join(options.output, "imageinfo.db"));

		var tasks = [];
		imageMap.forEach(function(img) {
			var p = imageloader.fetchMetadata(img).then(function() {
				if (img.imageinfo.mediatype === 'BITMAP') {
					return imageloader.fetch(img, imagedir);
				}
			}).then(function() {
				var metadata = {
					height: img.imageinfo.height,
					width: img.imageinfo.width,
					thumburl: img.src,
					url: img.imageinfo.url,
					descriptionurl: img.imageinfo.descriptionurl,
					sha1: img.imageinfo.sha1,
					// our extensions:
					mime: img.imageinfo.mime,
					mediatype: img.imageinfo.mediatype,
					filename: img.filename
				};
				return imageDb.put(img.resource, metadata);
			});
			tasks.push(p);
		});

		// return a promise to do all these tasks, then close the db
		return when.all(tasks).then(function() {
			return imageDb.close();
		});
	};

	var fetchRevisions = function() {
		// create list of titles to fetch
		var titles = [];
		//  ... all articles
		sourceMap.forEach(function(parsoidResult, revid) {
			titles.push({
				wiki: parsoidResult.wiki,
				title: parsoidResult.title,
				revid: revid
			});
		});
		//  ... all image pages
		imageMap.forEach(function(img) {
			if (img.imagerepository !== 'local') {
				// xxx fetch from commons
				/* jshint noempty: false */ // we know this is empty!
			} else {
				titles.push({
					wiki: img.wiki,
					title: img.short
					// images are always the 'latest' revision
				});
			}
		});
		return Revisions.fetchAndWrite(metabook.wikis, titles, options.output, log);
	};

	var writeMetabookNfoJson = function() {
		return when.map([
			{ filename: 'metabook.json', data: metabook },
			{ filename: 'nfo.json', data: nfo }
		], function(item) {
			return pcall(fs.writeFile, fs,
						 path.join(options.output, item.filename),
						 JSON.stringify(item.data));
		});
	};

	// promise to create the desired bundle!
	var createBundle = function() {
		log('Creating bundle');
		if (options.nozip) {
			// make the directory readable, then we're done.
			return pcall(fs.chmod, fs, options.output, 0755);
		}

		// create zip archive
		var tmpzip = options.output + '.tmp';
		var output = fs.createWriteStream(tmpzip, { flags: 'wx' });
		var archive = archiver('zip');
		archive.pipe(output);

		// recursively add files to the archive
		// don't compress .db files (so we can access them w/o unzipping)
		var addOne = function(base, f) {
			var shortpath = path.join(base, f);
			var fullpath = path.join(options.output, shortpath);
			var store = shortpath.endsWith('.db');
			return pcall(archive.append, archive,
						 fs.createReadStream(fullpath),
						 { name: shortpath, store: store } );
		};
		var p = when.map(pcall(fs.readdir, fs, options.output), function(f) {
			if (f === 'images') {
				var fullpath = path.join(options.output, f);
				return when.map(pcall(fs.readdir, fs, fullpath),
								addOne.bind(null, f));
			}
			return addOne('', f);
		});

		// finalize the archive when everything's been added
		p = p.then(function() {
			return pcall(archive.finalize, archive);
		});

		// work around archive buglet: finalize callback gets called before
		// stream is fully flushed
		var defer = when.defer();
		output.on('finish', function() {
			defer.resolve();
		});
		p = p.then(function() {
			return defer.promise;
		});

		// always clean up at the end
		p = p.ensure(function() {
			try {
				rimraf.sync(options.output);
				fs.renameSync(tmpzip, options.output);
			} catch (e1) { /* ignore */ }
			try {
				rimraf.sync(tmpzip);
			} catch (e2) { /* ignore */ }
		});
		return p;
	};

	return when.resolve()
		.then(mkOutputDir)
		.then(fetchSiteinfo)
		.then(fetchParsed)
		.then(mkImageDir)
		.then(fetchImages)
		.then(fetchRevisions)
		.then(writeMetabookNfoJson)
		.then(createBundle)
		.then(function() {
			log('Done.');
			return 0;
		}, function(err) {
			// clean up
			if (cleanUpOutput) {
				try {
					rimraf.sync(options.output);
				} catch (e) { /* ignore */ }
			}
			if (options.debug) {
				throw err;
			}
			console.error('Error:', err);
			return 1;
		});
};