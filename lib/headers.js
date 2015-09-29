// Request headers for API/Parsoid/RESTBase requests
'use strict';
require('core-js/shim');
var packageJson = require('../package.json');
var user = process.env.USER || process.env.LOGNAME || process.env.HOME ||
	'unknown';

// These are the headers we will send with every API request.
module.exports = {
	'User-Agent': [packageJson.name, packageJson.version, user].join('/'),
};
