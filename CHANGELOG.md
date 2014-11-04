# mw-ocg-bundler 1.2.0 (2014-11-04)
* Add `--bundle-size-limit` and `--image-size-limit` options to limit
  bundle and image size (bug 71647).
* Properly resolve URLs to decode titles.
* Improve Parsoid prefix guessing.
* Add `--parallel-request-limit` option to limit the number of
  simultanous API requests on small wikis (bug 71895).
* Add `-c` option to bundle a collection from the command-line.
* Fix "image size too big" check (bug 72377).
* Fix hangs caused by console output from `zip`.
* Update package dependencies.

# mw-ocg-bundler 1.1.0 (2014-09-30)
* Fix the `-d` option (images were being deleted from the directory).
* Download reliability fixes (fsync, download verification, etc).
* New logging framework.
* Save details of title redirects for zimwriter.
* Use `/etc/papersize` to select a default paper size.
* Reduce default maximum image resolution to 600x600 pixels.
* Improve `Metabook.fromArticles` API for external use.
* Fixes for various crashers.

# mw-ocg-bundler 1.0.1 (2014-07-29)
* Use siteinfo API to get content licence for each wiki used.
* Fix attribution links (handle protocol-relative URLs, etc).

# mw-ocg-bundler 1.0.0 (2014-07-26)
* Add `authors.db` database using the `prop=contributors` mediawiki
  API to record article authorship information.
* Add image metadata (artist, credit, license) to image database.
* Add `attribution.html` (and optionally `attribution.wt`) to localize
  attribution credits (generated from the above two databases).
* Use random filenames for images (security improvement).
* Robustness improvements (request timeouts and retries, disable
  request pool, use `readable-stream` on node 0.8).
* Handle protocol-relative urls.
* Performance improvements (skip more unnecessary fetches when
  `--no-compat` is given, increase some request batch size).

# mw-ocg-bundler 0.2.2 (2014-01-21)
* Add --no-compat, --no-follow, and --syslog CLI options.
* Follow wiki title redirects by default.
* Improve error handling.

# mw-ocg-bundler 0.2.1 (2013-12-18)
* Bug fixes to status reporting; add --size option to CLI.

# mw-ocg-bundler 0.2.0 (2013-12-04)
* Main change is consistent binary name (mw-ocg-bundler).

# mw-ocg-bundler 0.1.0 (2013-12-03)
* Initial release.
