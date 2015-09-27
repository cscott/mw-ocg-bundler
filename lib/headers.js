// Request headers for API/Parsoid/RESTBase requests
'use strict';
require('core-js/shim');
var packageJson = require('../package.json');

// These are the headers we will send with every API request.
module.exports = {
	'User-Agent': [packageJson.name, packageJson.version].join('/'),
};
