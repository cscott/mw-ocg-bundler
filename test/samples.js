/* global describe, it */
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var util = require('util');

var bundler = require('../');
var P = require('../lib/p');

var IMAGESIZE = 64; // Very small to keep downloads short.
// Extra logging in travis/jenkins, ensure they don't timeout w/o output.
var TRAVIS = !!(process.env.TRAVIS || process.env.ZUUL_COMMIT);

// Ensure that we don't crash on any of our sample inputs.
describe('Basic crash test', function() {
	['taoism.json', 'hurricanes.json', 'multiwiki.json', 'subpage.json'].forEach(function(name) {
		describe(name, function() {
			it('should bundle', function() {
				this.timeout(0);
				process.setMaxListeners(0);
				var filename = path.join(__dirname, '..', 'samples', name);
				return P.call(fs.readFile, fs, filename, 'utf8')
					.then(function(metabook) {
						metabook = JSON.parse(metabook);
						return bundler.bundle(metabook, {
							output: filename + '.zip',
							apiVersion: 'restbase1',
							size: IMAGESIZE,
							debug: TRAVIS,
							compat: true,
							follow: true,
							saveRedirects: true,
							fetchModules: true,
							log: function() {
								if (!TRAVIS) { return; }
								var time = new Date().toISOString().slice(11,23);
								console.log(time, util.format.apply(util, arguments));
							},
						});
					}).then(function(_) {
						// Should resolve with no value.
						assert.equal(_, undefined);
					}).finally(function() {
						try {
							fs.unlinkSync(filename + '.zip');
						} catch (e) { }
					});
			});
		});
	});
});
