//
// Module to be invoked from an AWS Lambda function to perform the Stacy magic.
//
// author: Lev Himmelfarb <lev@boylesoftware.com>
//
// Copyright (c) 2016 Boyle Software, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//

'use strict';

const http = require('http');
const Contentful = require('contentful');
const Handlebars = require('handlebars');
const AWS = require('aws-sdk');
const marked = require('marked');

const s3 = new AWS.S3();

//
// Site data loaders.
//

function loadSiteConfig(siteConfigsBucket, site) {

	console.log(
		'loading site "' + site + '" configuration from ' +
			siteConfigsBucket + ':' + site + '-config.json');

	return s3.getObject({
		Bucket: siteConfigsBucket,
		Key: site + '-config.json'
	}).promise().then(
		response => {
			console.log('loaded site "' + site + '" configuration');
			try {

				// parse the site configuration
				const siteConfig = JSON.parse(response.Body.toString('utf8'));

				// set missing defaults
				if (!siteConfig.pageContentTypes)
					siteConfig.pageContentTypes = [ 'page' ];
				if (!siteConfig.pageSlugFieldName)
					siteConfig.pageSlugFieldName = 'slug';
				if (!siteConfig.assetsFolder)
					siteConfig.assetsFolder = 'assets';
				if (siteConfig.maxDepth === undefined)
					siteConfig.maxDepth = 3;
				if (!siteConfig.contentMetaS3Key)
					siteConfig.contentMetaS3Key = site + '-content-meta.json';

				// return the configuration object
				return siteConfig;

			} catch (err) {
				return Promise.reject(err);
			}
		},
		err => Promise.reject(err)
	);
}

function loadContentMeta(site, siteConfig) {

	console.log(
		'loading site "' + site + '" content metadata from ' +
			siteConfig.contentMetaS3Bucket + ':' + siteConfig.contentMetaS3Key);

	return s3.getObject({
		Bucket: siteConfig.contentMetaS3Bucket,
		Key: siteConfig.contentMetaS3Key
	}).promise().then(
		response => {
			console.log('loaded site "' + site + '" content metadata');
			try {
				return JSON.parse(response.Body.toString('utf8'));
			} catch (err) {
				return Promise.reject(err);
			}
		},
		err => {
			if (err.code === 'NoSuchKey') {
				console.log(
					'site "' + site +
						'" content metadata does not exist, creating new');
				return {
					refsMap: {},
					topEntries: {},
					assets: {}
				};
			}
			return Promise.reject(err);
		}
	);
}

function loadContent(site, siteConfig, entryIds) {

	console.log(
		'loading site "' + site + '" content from Contentful space ' +
			siteConfig.contentfulSpaceId);

	const cfClient = Contentful.createClient({
		space: siteConfig.contentfulSpaceId,
		accessToken: siteConfig.contentfulAPIKey
	});

	let query = {
		'include': siteConfig.maxDepth
	};
	if (entryIds.length > 1)
		query['sys.id[in]'] = entryIds.join(',');
	else
		query['sys.id'] = entryIds[0];

	return cfClient.getEntries(query).then(
		entries => {

			console.log('loaded site "' + site + '" content');

			const content = {};
			entries.items.forEach(entry => {
				content[entry.sys.id] = entry;
			});

			return content;
		},
		err => Promise.reject(err)
	);
}

//
// Contentful event handlers.
//

const HANDLED_EVENTS = {
	'ContentManagement.Entry.publish': processPublishEntry,
	'ContentManagement.Entry.unpublish': processUnpublishEntry,
	'ContentManagement.Asset.publish': processPublishAsset,
	'ContentManagement.Asset.unpublish': processUnpublishAsset
};

function processPublishEntry(eventCtx, entry) {

	console.log('processing publish entry event');

	// some used references
	const siteConfig = eventCtx.siteConfig;
	const contentMeta = eventCtx.contentMeta;
	const refsMap = contentMeta.refsMap;
	const entryId = entry.sys.id;

	// check if page
	if (siteConfig.pageContentTypes.indexOf(
		entry.sys.contentType.sys.id) >= 0) {
		const entryIdString = String(entryId);
		const oldSlug = contentMeta.topEntries[entryIdString];
		const newSlugField = entry.fields[siteConfig.pageSlugFieldName];
		const newSlug = newSlugField[Object.keys(newSlugField)[0]];
		if (newSlug !== oldSlug) {
			contentMeta.topEntries[entryIdString] = newSlug;
			eventCtx.contentMetaUpdated = true;
		}
	}

	// find all reference fields
	const fields = entry.fields;
	Object.keys(fields).forEach(fieldName => {
		const field = fields[fieldName];
		Object.keys(field).forEach(lang => {
			const fieldValue = field[lang];
			const vals = (
				Array.isArray(fieldValue) ? fieldValue : [ fieldValue ]);
			vals.forEach(val => {
				if (val && val.sys && (val.sys.type === 'Link')
					&& (val.sys.linkType === 'Entry')) {
					const referredEntryId = val.sys.id;
					let referrers = refsMap[referredEntryId];
					if (!referrers)
						refsMap[referredEntryId] = referrers = [];
					if (referrers.indexOf(entryId) < 0) {
						referrers.push(entryId);
						eventCtx.contentMetaUpdated = true;
					}
				}
			});
		});
	});

	// find affected top-level entries (pages)
	function processRefsChain(id) {
		let referrers = refsMap[id];
		if (referrers) {
			referrers.forEach(processRefsChain);
		} else {

			// get page slug
			const slug = contentMeta.topEntries[String(id)];
			if (slug) {

				// add to entries to regenerate, if not there yet
				if (eventCtx.entryIdsToRegen.indexOf(id) < 0)
					eventCtx.entryIdsToRegen.push(id);

				// don't unpublish
				const ind = eventCtx.pageSlugsToRemove.indexOf(slug);
				if (ind >= 0)
					eventCtx.pageSlugsToRemove.splice(ind, 1);
			}
		}
	}
	processRefsChain(entryId);
}

function processUnpublishEntry(eventCtx, entryDeletion) {

	console.log('processing unpublish entry event');

	// get top-entry slug
	const entryId = entryDeletion.sys.id;
	const entryIdString = String(entryId);
	const slug = eventCtx.contentMeta.topEntries[entryIdString];

	// ignore any non-top-level entries
	if (!slug)
		return;

	// remove from top-entries
	delete eventCtx.contentMeta.topEntries[entryIdString];
	eventCtx.contentMetaUpdated = true;

	// remove the page
	eventCtx.pageSlugsToRemove.push(slug);

	// don't recompile
	const ind = eventCtx.entryIdsToRegen.indexOf(entryId);
	if (ind >= 0)
		eventCtx.entryIdsToRegen.splice(ind, 1);
}

function processPublishAsset(eventCtx, asset) {

	// get asset id and file
	const assetId = asset.sys.id;
	const assetFile = asset.fields.file[Object.keys(asset.fields.file)[0]];

	// log the event
	console.log(
		'processing publish asset event: site "' + eventCtx.site + '", asset #' +
			assetId + ' (' + assetFile.fileName + ')');

	// update assets mapping in the content metadata
	eventCtx.contentMeta.assets[assetId] = assetFile.fileName;
	eventCtx.contentMetaUpdated = true;

	// remove previous publish, if any
	eventCtx.assetsToPublish = eventCtx.assetsToPublish.filter(
		a => (a.sys.id !== assetId));

	// add to assets to publish
	eventCtx.assetsToPublish.push(asset);

	// don't remove
	const ind = eventCtx.assetFileNamesToRemove.indexOf(assetFile.fileName);
	if (ind >= 0)
		eventCtx.assetFileNamesToRemove.splice(ind, 1);
}

function processUnpublishAsset(eventCtx, assetDeletion) {

	console.log('processing unpublish asset event');

	// get asset id and file name
	const assetId = assetDeletion.sys.id;
	const assetFileName = eventCtx.contentMeta.assets[assetId];

	// log the event
	console.log(
		'processing unpublish asset event: site "' + eventCtx.site +
			'", asset #' + assetId + ' (' + assetFileName + ')');

	// check if we have the mapping in the content metadata
	if (!assetFileName) {
		console.warn(
			'no file name mapping for asset #' + assetId + ' in site "' +
				eventCtx.site +
				'" content metadata, skipping asset unpublish event');
		return;
	}

	// update assets mapping in the content metadata
	delete eventCtx.contentMeta.assets[assetId];
	eventCtx.contentMetaUpdated = true;

	// add to asset ids to remove if not there yet
	const ind = eventCtx.assetFileNamesToRemove.indexOf(assetFileName);
	if (ind < 0)
		eventCtx.assetFileNamesToRemove.push(assetFileName);

	// don't publish
	eventCtx.assetsToPublish = eventCtx.assetsToPublish.filter(
		a => (a.sys.id !== assetId));
}

//
// Tasks.
//

function compilePage(siteConfig, siteTemplates, content, entryId) {

	const entry = content[entryId];
	if (!entry) {
		console.warn(
			'no entry in the content for page #' + entryId +
				', skipping page generation');
		return;
	}

	return s3.putObject({
		Bucket: siteConfig.contentS3Bucket,
		Key: entry.fields[siteConfig.pageSlugFieldName] + '.html',
		ContentType: 'text/html',
		Body: new Buffer(
			siteTemplates[entry.sys.contentType.sys.id](entry.fields), 'utf8')
	}).promise();
}

function removePage(siteConfig, pageSlug) {

	return s3.deleteObject({
		Bucket: siteConfig.contentS3Bucket,
		Key: pageSlug + '.html'
	}).promise();
}

function saveContentMeta(siteConfig, contentMeta) {

	return s3.putObject({
		Bucket: siteConfig.contentMetaS3Bucket,
		Key: siteConfig.contentMetaS3Key,
		ContentType: 'application/json',
		Body: new Buffer(JSON.stringify(contentMeta), 'utf8')
	}).promise();
}

function publishAsset(siteConfig, asset) {

	const assetFile = asset.fields.file[Object.keys(asset.fields.file)[0]];

	return new Promise((resolve, reject) => {
		const assetUrl = 'http:' + assetFile.url;
		console.log('loading asset from ' + assetUrl);
		http.request(assetUrl)
			.on('response', response => {
				if (response.statusCode !== 200)
					return reject(new Error(
						'could not load asset from ' + assetUrl + ': ' +
							response.statusCode + ' (' +
							response.statusMessage + ')'));
				s3.upload({
					Bucket: siteConfig.contentS3Bucket,
					Key: siteConfig.assetsFolder + '/' + assetFile.fileName,
					ContentType: assetFile.contentType,
					ContentLength: assetFile.details.size,
					Body: response
				}, (err, data) => {
					if (err)
						return reject(err);
					resolve();
				});
			})
			.end();
	});
}

function removeAsset(siteConfig, assetFileName) {

	return s3.deleteObject({
		Bucket: siteConfig.contentS3Bucket,
		Key: siteConfig.assetsFolder + '/' + assetFileName
	}).promise();
}

//
// Main logic.
//

function processKinesisRecord(siteConfigsBucket, siteEventCtxs, record) {

	// parse Contentful event
	const cfEvent = JSON.parse(
		(new Buffer(record.kinesis.data, 'base64')).toString('utf8'));
	console.log(
		'received ' + cfEvent.topic + ' event for site "' + cfEvent.site + '"');

	// get the event handler
	const eventHandler = HANDLED_EVENTS[cfEvent.topic];
	if (!eventHandler)
		return;

	// get the site event context
	const site = cfEvent.site;
	let eventCtx = siteEventCtxs[site];
	if (!eventCtx) {

		// create context object
		eventCtx = {
			site: site,
			siteConfig: undefined,
			contentMeta: undefined,
			contentMetaUpdated: false,
			entryIdsToRegen: [],
			pageSlugsToRemove: [],
			assetsToPublish: [],
			assetFileNamesToRemove: []
		};

		// load site configuration and content metadata
		eventCtx.processingChain = loadSiteConfig(siteConfigsBucket, site).then(
			siteConfig => {
				eventCtx.siteConfig = siteConfig;
				try {
					return loadContentMeta(site, siteConfig);
				} catch (err) {
					return Promise.reject(err);
				}
			},
			err => Promise.reject(err)
		).then(
			contentMeta => {
				eventCtx.contentMeta = contentMeta;
			},
			err => Promise.reject(err)
		);

		// remember context object for the site
		siteEventCtxs[site] = eventCtx;
	}

	// process the event
	eventCtx.processingChain = eventCtx.processingChain.then(
		() => {
			try {
				eventHandler.call(
					null, eventCtx, cfEvent.payload);
			} catch (err) {
				return Promise.reject(err);
			}
		},
		err => Promise.reject(err)
	);
}

function startSiteTasks(eventCtx, templates) {

	const site = eventCtx.site;
	const siteConfig = eventCtx.siteConfig;

	console.log('starting tasks for site "' + site + '"');

	// functions for creating tasks
	function onTaskError(taskDesc, err) {
		console.error(
			'for site "' + site + '" failed to ' + taskDesc + ':', err);
	}
	function createTask(taskDesc, requiredDataPromise, taskFn) {
		return requiredDataPromise.then(
			(requiredData) => {
				console.log(
					'for site "' + site + '" starting task: ' + taskDesc);
				try {
					const startedAt = Date.now();
					return taskFn.call(null, requiredData).then(
						() => {
							console.log(
								'for site "' + site +
									'" finished task: ' + taskDesc + ' (' +
									String(Date.now() - startedAt) + 'ms)');
						},
						err => {
							onTaskError(taskDesc, err);
						}
					);
				} catch (err) {
					onTaskError(taskDesc, err);
				}
			},
			err => {
				onTaskError(taskDesc, err);
			}
		);
	}

	// the task promises
	const tasks = [];

	// check if any pages need to be regenerated
	if (eventCtx.entryIdsToRegen.length > 0) {

		// load content
		const contentPromise = loadContent(
			site, siteConfig, eventCtx.entryIdsToRegen);

		// create Handlebars instance
		const hbs = Handlebars.create();

		// register site templates
		const siteTemplates = {};
		Object.keys(templates[site]).forEach(templateName => {
			siteTemplates[templateName] = hbs.template(
				templates[site][templateName]);
		});

		// register template helpers
		const assetsFolder = siteConfig.assetsFolder;
		const markedRenderer = new marked.Renderer();
		markedRenderer.image = function(href, title, text) {
			return '<img src="' + assetsFolder +
				href.substring(href.lastIndexOf('/')) +
				'" alt="' + text + '"/>';
		};
		hbs.registerHelper(
			'module',
			entry => siteTemplates[entry.sys.contentType.sys.id](entry.fields));
		hbs.registerHelper(
			'assetSrc',
			asset => assetsFolder + '/' + asset.fields.file.fileName);
		hbs.registerHelper(
			'markdown',
			data => marked(data, { renderer: markedRenderer }));

		// add page regeneration tasks
		eventCtx.entryIdsToRegen.forEach(entryId => {
			tasks.push(createTask(
				'generate page #' + entryId + ' (' +
					eventCtx.contentMeta.topEntries[String(entryId)] + ')',
				contentPromise,
				content => compilePage(
					siteConfig, siteTemplates, content, entryId)
			));
		});
	}

	// empty required data promise
	const noRequiredData = Promise.resolve();

	// add page removal tasks
	eventCtx.pageSlugsToRemove.forEach(pageSlug => {
		tasks.push(createTask(
			'remove page (' + pageSlug + ')',
			noRequiredData,
			() => removePage(siteConfig, pageSlug)
		));
	});

	// add asset publication tasks
	eventCtx.assetsToPublish.forEach(asset => {
		tasks.push(createTask(
			'publish asset #' + asset.sys.id + ' (' +
				eventCtx.contentMeta.assets[asset.sys.id] + ')',
			noRequiredData,
			() => publishAsset(siteConfig, asset)
		));
	});

	// add asset removal tasks
	eventCtx.assetFileNamesToRemove.forEach(assetFileName => {
		tasks.push(createTask(
			'remove asset (' + assetFileName + ')',
			noRequiredData,
			() => removeAsset(siteConfig, assetFileName)
		));
	});

	// add save content metadata task
	if (eventCtx.contentMetaUpdated)
		tasks.push(createTask(
			'save content metadata',
			noRequiredData,
			() => saveContentMeta(siteConfig, eventCtx.contentMeta)
		));

	// return promise of the site tasks completion
	return Promise.all(tasks);
}

exports.createHandler = function(options) {

	// return the Lambda handler function
	return function(event, context, callback) {

		console.log('invoked content event handler');

		// catch exceptions
		try {

			// create event contexts holder for the sites
			const siteEventCtxs = {};

			// get records from the stream and add processors to the chain
			event.Records.forEach(record => {
				processKinesisRecord(
					options.siteConfigsS3Bucket, siteEventCtxs, record);
			});

			// start tasks for each site and wait for their completion
			console.log('all events consumed, starting tasks...');
			Promise.all(Object.keys(siteEventCtxs).map(site => {
				const eventCtx = siteEventCtxs[site];
				return eventCtx.processingChain.then(
					() => {
						try {
							return startSiteTasks(eventCtx, options.templates);
						} catch (err) {
							console.error(
								'failed to start tasks for site "' + site + '":',
								err);
						}
					},
					err => {
						console.error(
							'failed to process events for site "' + site + '":',
							err);
					}
				);
			})).then(
				() => {
					console.log('content event handler finished');
					callback(null);
				}
				// never rejected
			);

		} catch (err) {
			callback(err);
		}
	};
};
