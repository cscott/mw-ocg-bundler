# mw-ocg-bundler
[![NPM][NPM1]][NPM2]

[![Build Status][1]][2] [![dependency status][3]][4] [![dev dependency status][5]][6]

A mediawiki article spider tool.

This tool grabs all the dependencies for a given set of articles and
creates a directory or zip file.  The format is documented at
https://www.mediawiki.org/wiki/PDF_rendering/Bundle_format

## Installation

Node version 0.8 and 0.10 are tested to work.

Install the node package depdendencies with:
```
npm install
```

Install other system dependencies.
```
apt-get install zip
```

## Running

To generate a bundle for the `en.wikipedia.org` article `United States`:
```
bin/mw-ocg-bundler -v -o bundle.zip -h en.wikipedia.org "United States"
```

To generate a bundle for a collection of articles about the inner planets:
```
bin/mw-ocg-bundler -v -o bundle.zip -h en.wikipedia.org --title Planets Mercury Venus Earth Mars
```

If you have a book specification (in the form of `metabook.json` and
`nfo.json` files), use:
```
bin/mw-ocg-bundler -v -o bundle.zip -m metabook.json -n nfo.json
```

For non-interactive use feel free to remove the `-v` flag.

If you are running a local mediawiki instance, use appropriate `-h`,
`--parsoid-api`, and `--php-api` options to point at your local wiki and local
Parsoid installation:
```
bin/mw-ocg-bundler -v -o bundle.zip -h localhost --parsoid-api http://localhost:8142 --php-api http://localhost/api.php "Main Page"
```

Note that the argument to `-h` must match the "domain" you've
configured in Parsoid's `localsettings.js` and MediaWiki's
`$wgVirtualRestConfig`; it doesn't necessarily need to be a valid
DNS domain.  See [Visual Editor's configuration guide] for more details.

For other options, see:
```
bin/mw-ocg-bundler --help
```

There are several rendering backends which take bundles in this format
as inputs.  See [mw-ocg-latexer], for instance, which generates PDFs
of mediawiki articles via [XeLaTeX], and [mw-ocg-texter] which generates
plaintext versions of mediawiki articles.

## License

Copyright (c) 2013-2014 C. Scott Ananian

Licensed under GPLv2.

[mw-ocg-latexer]: https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-latex_renderer
[mw-ocg-texter]:  https://github.com/cscott/mw-ocg-texter
[XeLaTeX]:        https://en.wikipedia.org/wiki/XeTeX
[Visual Editor's configuration guide]:  https://www.mediawiki.org/wiki/Extension:VisualEditor#Linking_with_Parsoid

[NPM1]: https://nodei.co/npm/mw-ocg-bundler.png
[NPM2]: https://nodei.co/npm/mw-ocg-bundler/

[1]: https://travis-ci.org/cscott/mw-ocg-bundler.svg
[2]: https://travis-ci.org/cscott/mw-ocg-bundler
[3]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-bundler.svg
[4]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-bundler
[5]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-bundler/dev-status.svg
[6]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-bundler#info=devDependencies
