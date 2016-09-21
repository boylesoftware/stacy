# Creating a Website with Stacy

Setting up a website with [Stacy](https://github.com/boylesoftware/stacy) involves a substantial number of steps, which may be a bit overwhelming, especially for those who do it for the first time. Using a simple example, this tutorial provides guidance, which can be used as a reference every time a new site needs to be brought up.

In general, the setup includes three major pieces:

* The website project, which is a collection of website source files including page and module templates, website static content, build scripts, etc. The project is normally managed under a source control system, such as [git](https://git-scm.com). The website developers are the group that works with the project.

* The AWS infrastructure. Normally, it includes an API Gateway API, a Kinesis stream, a Lambda function, and IAM role and a few S3 buckets, including the bucket, from which the website is served. Once setup, the infrastructure requires little attention. When something changes in the website project (for example changes in the templates) and developers create a new website release, the Lambda function is recompiled and redeployed (this is because the Lambda function includes the pre-compiled wesite templates). Note, that with Stacy most of the same infrastructure can be used by multiple websites.

* The Contentful space, where the website content lives. The developers setup content types and the webhook that calls the API Gateway upon content publish and unpublish. For every content type, there is a matching template in the website project. Once setup, the space is used by the authors for the routine content management. Whenever a piece of content is published (or unublished), Stacy automatically makes the corresponding changes in the website's S3 bucket uploading and removing website asset files and generating and removing the affected pages.

For this tutorial, let's create a simple website that consists of a single blog-like page. The page is going to display a title and a bunch of posts. Each post is going to consist of a caption, a picture and a rich text block with the post content:

![Site Screenshot](https://raw.githubusercontent.com/boylesoftware/stacy/master/docs/img/site_screenshot.png)

## The Website Project

The website project consists of three major pieces:

* *The website static content.* This includes the CSS stylesheets, images and fonts used for the site decoration, JavaScript files, etc. The static content is uploaded once into the website S3 bucket and remains there unaffected by the content management events.

* *The templates.* These are [Handlebars](http://handlebarsjs.com) templates for the website pages and any modules included in those pages. In Contentful CMS, every content entry has a content type identified by a slug-like id. The content type determines what data fields are available for the authors to edit for any content entry of the given type. Every content type used by the site must have a matching Handlebars template. When the template is combined with the content entry data, a piece of HTML is produced. If the content type is a top-level page content type, the HTML is published as an HTML file in the website's S3 bucket. If it's a module, all pages that include that module are regenerated and republished. To match a template with a content type, the template file name (without the file extention) must be the same as the content type id.

* *The Lambda function.* This is the function that calls Stacy to process the publish and unpublish events coming through the API Gateway and the Kinesis stream from Contentful. Stacy uses Node.js runtime.

Using [Gulp](http://gulpjs.com) as the project build system, we can have the following project files structure:

```
src/
  img/
    <static image files>
  css/
    style.css
  templates/
    modules/
	  post.hbs
    page.hbs
  lambda/
    index.js
	package.json
gulpfile.js
package.json
```

Next, let's have a detailed look at different project components.

### The Build File

The project build produces two artifacts:

* The static content to be manually uploaded to the website S3 bucket once.

* The Lambda function ZIP package to be deployed.

Do do that, we could have the `gulpfile.js` look something like the following:

```javascript
'use strict';

const gulp = require('gulp');
const gulpLoadPlugins = require('gulp-load-plugins');

const plugins = gulpLoadPlugins();

const SITE_ID = 'allaboutpets';

gulp.task('static-img', function() {
	return gulp.src('src/img/*.{png,jpg}')
		.pipe(gulp.dest('dist/static/img'));
});

gulp.task('static-css', function() {
	return gulp.src('src/css/*.css')
		.pipe(plugins.cleanCss())
		.pipe(plugins.rename({
			suffix: '.min'
		}))
		.pipe(gulp.dest('dist/static/css'));
});

gulp.task('static', [ 'static-img', 'static-css' ]);

gulp.task('lambda-templates', function() {
	return gulp.src('src/templates/**/*.hbs')
		.pipe(plugins.handlebars({
			handlebars: require('handlebars')
		}))
		.pipe(plugins.declare({
			root: 'exports["' + SITE_ID + '"]',
			noRedeclare: true
		}))
		.pipe(plugins.concat('templates.js'))
		.pipe(plugins.wrap('exports["' + SITE_ID + '"] = {};\n<%= contents %>'))
		.pipe(gulp.dest('dist/lambda'));
});

gulp.task('lambda-handler', function() {
	return gulp.src([ 'src/lambda/**/*.js', 'src/lambda/package.json' ])
		.pipe(gulp.dest('dist/lambda'))
		.pipe(plugins.install({
			production: true
		}))
		.pipe(gulp.dest('dist/lambda'));
});

gulp.task('lambda', [ 'lambda-templates', 'lambda-handler' ], function() {
	return gulp.src('dist/lambda/**')
		.pipe(plugins.zip('lambda.zip'))
		.pipe(gulp.dest('dist'));
});

gulp.task('default', [ 'static', 'lambda' ]);

```

Besides Gulp itself, this script requires the following NPM packages as its development dependencies: [gulp-cleancss](https://www.npmjs.com/package/gulp-cleancss), [gulp-concat](https://www.npmjs.com/package/gulp-concat), [gulp-declare](https://www.npmjs.com/package/gulp-declare), [gulp-handlebars](https://www.npmjs.com/package/gulp-handlebars), [gulp-install](https://www.npmjs.com/package/gulp-install), [gulp-load-plugins](https://www.npmjs.com/package/gulp-load-plugins), [gulp-rename](https://www.npmjs.com/package/gulp-rename), [gulp-wrap](https://www.npmjs.com/package/gulp-wrap), [gulp-zip](https://www.npmjs.com/package/gulp-zip) and [handlebars](https://www.npmjs.com/package/handlebars) (to use most recent version instead of what's used by gulp-handlebars plugins by default). Each of these plugins can be added to the project's `package.json` using NPM, for example, like this:

```sh
$ npm install --save-dev gulp-handlebars
```

The static content produced by the `gulpfile.js` script above will be placed under `dist/static`, and the Lambda function package will be at `dist/lambda.zip`.

Note, that in the script we use `SITE_ID`, which is set to "allaboutpets". We are going to encounter the site id notion later on in this guide, but for now we can say that, as mentioned earlier, a single Lambda function deployment can handle more than one website. To distinguish templates for different websites, the `templates` object used by Stacy has two levels of keys: the first level is the site id, and the second level is the template name (that is the Contentful content type id). We will see later that every content management event passed on to Stacy carries the site id, which allows the correct bundle of templates to be selected from the `templates` object. The site id can be any string, but preferrably it should be short and URL-friendly.

### The Lambda Function

Now let's have a look at our Lambda function under `src/lambda`. The `package.json` will be included in the produced package ZIP file for Lambda deployment and can look something like the following:

```json
{
  "name": "allaboutpets-website-lambda",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "stacy": "^1.0.0"
  }
}
```

To get the latest Stacy dependency it's best to use NPM in the `src/lambda` folder:

```sh
$ npm install --save stacy
```

All the Lambda function in `index.js` needs to do is to call Stacy and pass it some site-specific options:

```javascript
'use strict';

const Stacy = require('stacy');

exports.handler = Stacy.createHandler({
    siteConfigsS3Bucket: 'allaboutpets-stacy',
    templates: require('./templates')
});
```

The `templates` property in the `Stacy.createHandler` options object simply passes on the templates generated by our Gulp script. The `siteConfigsS3Bucket` property points to an Amazon S3 bucket that holds site specific configuration files. We are going to create this bucket and upload the site configuration file into it later in this guide. For now we will just say that the site configuration file is a JSON file that provides such options as the name of the target website S3 bucket, the Contentful API key and the space id, etc.

### The Templates

Finally, we can create our templates. We are going to have one top page template for content type "page" and one module template for content type "post". The templates use regular [Handlebars](http://handlebarsjs.com) syntax with an object that contains the corresponding content entry fields as the template context object. In addition to the standard Handlebars built-in helpers, Stacy provides three additional ones:

* `module <reference field name>` - Given a content entry field that is a reference to another entry, include the referred entry.
* `assetSrc <asset field name>` - Given a content entry field that is a reference to a media asset, get the asset's URL.
* `markdown <long text field name>` - Given a content entry field that is a long text field that uses Markdown syntax, render the Markdown as HTML.

That way, our top page template `page.hbs` can look like the following:

```handlebars
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>{{title}}</title>
    <link href="css/style.min.css" rel="stylesheet" type="text/css"/>
  </head>
  <body>
    <h1>{{title}}</h1>
	{{#each posts}}{{{module this}}}{{/each}}
  </body>
</html>
```

Note, that later on we are going to define two fields for our `page` content type in Contentful: the `title`, which is going to be a short text field, and the `posts`, which is going to be an array of references to our `post` entries.

The `post.hbs` then can look like the following:

```handlebars
<section class="post">
  <h2>{{caption}}</h2>
  <img class="post-pic" src="{{assetSrc picture}}"/>
  {{{markdown content}}}
</section>
```

Our `post` content type in Contentful is going to have three fields: the `caption`, the `picture`, which is going to be a reference to a image media asset, and the `content`, which is going to be a long text field with Markdown syntax.

Note, that in these templates we use tripple-braces for the `module` and for the `markdown` helpers to disable Handlebars escaping of the HTML produced by those helpers.

## The AWS Infrastructure

Now that we have our project, we can setup our AWS environment. Let's do it piece by piece.

### The Kinesis Stream

Login to your AWS Management Console, go to the Amazon Kinesis Streams service and hit Create Stream button:

![Kinesis Screenshot](https://raw.githubusercontent.com/boylesoftware/stacy/master/docs/img/kinesis_screenshot.png)

For the purposes of this guide we are going to name our stream "stacy". One shard should be sufficient. Note, that later on we are going to use site id as the partition key for the content management events so that all events for the same site go to the same shard and arrive to our Lambda function in the correct order. Unless your setup handles really large number of sites and/or sees **a lot** of content management activity, a single shard should be able to handle all of it.

Alternatively, you can use AWS CLI to create the stream:

```sh
$ aws kinesis create-stream --stream-name stacy --shard-count 1
```

### The IAM Role

All components of our Stacy setup are going run using a single IAM role. For this guide, we are going to name the role "stacy". To create it, go to the IAM service in the AWS Management Console, select Roles on the left and hit Create New Role Button:

![Role Screenshot](https://raw.githubusercontent.com/boylesoftware/stacy/master/docs/img/role_screenshot.png)

In the following screens select AWS Lambda as the role type, don't select any attached policies (we are going to attach policies later as a separate step), and proceed to creating the role.

After the role is created, select it in the console, in the Permissions tab select Inline Policies and click the link to create the policy. In the following screen choose Custom Policy, hit Select button and in the policy editor that opens enter the policy details. You can name the policy "Stacy" and use policy document such as follows:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "kinesis:GetRecords",
                "kinesis:GetShardIterator",
                "kinesis:DescribeStream",
                "kinesis:PutRecord"
            ],
            "Resource": [
                "arn:aws:kinesis:<region>:<account id>:stream/stacy"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "*"
        }
    ]
}
```

This policy gives your role read/write access to the Kinesis stream and allows it to write log messages to the CloudWatch service.

Note, that in the `Resource` field in the first policy statement you must use the ARN of the Kinesis stream that you just created. Unfortunately, there is no easy way to find it in the AWS Management Console, so you need to construct it. In the stream ARN in the example above, replace `<region>` with your region id (such as "us-east-1", for example) and `<account id>` with your AWS account id. To find your account id, in the IAM role details screen look at your newly created "stacy" role. At the top of the screen, in the Role ARN field, the account id is the number between colons just before the "role/stacy" ending of the ARN.

After you apply the inline policy to the role, go to the Trust Relationships tab and hit Edit Trust Relationship button. Apply the following policy document:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": [
                    "apigateway.amazonaws.com",
                    "lambda.amazonaws.com"
                ]
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```

This will allow your role to execute the API Gateway logic as well as the Lambda function.

Alternatively, the AWS CLI can be used to create and configure the role:

```sh
$ aws iam create-role --role-name stacy --assume-role-policy-document file://trust.json
```

And then to attach the inline policy:

```sh
$ aws iam put-role-policy --role-name stacy --policy-name Stacy --policy-document file://policy.json
```

### API Gateway

In the AWS Management Console go to the API Gateway service and create a new API selecting the New API option (not the default Example API). Call the API "stacy" for the purpose of this guide:

![New API Screenshot](https://raw.githubusercontent.com/boylesoftware/stacy/master/docs/img/newapi_screenshot.png)

Now, using the Actions dropdown button, create resources under `/sites/{site}/content-events` (three resource one under another). Then, under the leaf `content-events` resource, create a method `POST`. For the integration type select AWS Service, select the region (same as for the Kinesis stream), select Kinesis as the AWS Service, select "POST" as the HTTP method, "Use action name" as the Action Type, type "PutRecord" in the Action, and put your "stacy" role's ARN in the Execution role:

![API Screenshot](https://raw.githubusercontent.com/boylesoftware/stacy/master/docs/img/api2_screenshot.png)

There are still some things that need to be done to finish the API construction:

1. In the Method Request block set the API Key Required field to true and add `X-Contentful-Topic` in the HTTP Request Headers.

2.  In the Integration Request block go to HTTP Headers and add `Content-Type` header mapping `'application/x-amz-json-1.1'` (note the single quotes!). The go to the Body Mapping Templates, select Never in the Content body passthrough, then add mapping template for content type `application/vnd.contentful.management.v1+json`. The template should be:

  ```
  #set($rec = "{
      ""site"": ""$input.params('site')"",
      ""topic"": ""$input.params('X-Contentful-Topic')"",
      ""payload"": $input.json('$')
  }")
  {
      "StreamName": "$stageVariables.streamName",
      "PartitionKey": "$input.params('site')",
      "Data": "$util.base64Encode($rec)"
  }
  ```

  This template creates a Kinesis record as it is expected by the Stacy Lambda function from the Contentful event POST submitted by the Contentful webhook.

3. In the Method Response block add HTTP Status code 500.

4. And finally in the Integration Response block, add integration response and map HTTP status regex `[^2].*` to method response status 500.

Now, the API has been constructuted, but we still need a few things. First, create an API key: go to the API Keys using the navigation on the left of the screen and use Create API key action. You can name the key "Contentful" (it's for the Contentful webhooks to call the API) and auto-generate it.

Then, go to the Usage Plans and create a new plan (configure it accordingly for throtthling and quota). Skip Associated API Stages step. Add your API key to the plan.

Now that you have the key and the usage plan, you can deploy your API. Go back to the API and select Deploy API in the Actions. Create a new deployment stage (call it "prod", for example) and hit Deploy button. After the API is deployed, the console will show you your endpoint URL, which will look something like:

```
https://<api id>.execute-api.<region>.amazonaws.com/prod
```

Now, note that our integration request body mapping template uses a stage variable for the target Kinesis stream name. In the Stages section of your API, select your "prod" (or whatever name you gave it) stage, go to the Stage Variable tab and add a stage variable called `streamName`. The value should be your stream name, which is "stacy" if you followed the instructions above.

Done!

*Note, that you can get Stacy source from GitHub and it includes a shell script under misc/aws-setup that performs all the AWS setup steps described up to this point using local AWS CLI.*

### The S3 Buckets

Next, we need to create and configure the S3 buckets. In this guide, we are going to use two separate buckets: one for the sites configuration and content metadata, and one for the actual site content served.

#### Website Content Bucket

This is the bucket, from which the website is served. For the purpose of this guide, let's call the bucket `allaboutpets-website`. In the AWS Management Console go to S3 service and create it (or use AWS CLI). In the permissions section of the bucket properties, add a new bucket policy:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Principal": {
				"AWS": "arn:aws:iam::xxx:role/stacy"
			},
			"Action": [
				"s3:DeleteObject",
				"s3:PutObject"
			],
			"Resource": "arn:aws:s3:::allaboutpets-website/*"
		},
		{
			"Effect": "Allow",
			"Principal": "*",
			"Action": "s3:GetObject",
			"Resource": "arn:aws:s3:::allaboutpets-website/*"
		}
	]
}
```

Replace the principal ARN in the example above with your stacy role ARN and the resource ARNs with your bucket ARN.

This policy allows Stacy to upload and delete files in the bucket and also it allows reading the bucket content to the whole world. Now, in the Static Website Hosting section of the bucket properties enable the website hosting.

At this point, you can build your website project with Gulp and upload the contents of the `dist/static` folder into the bucket.

#### Configuration and Content Metadata Bucket

This is the bucket, to which `siteConfigsS3Bucket` property of the options object passed to Stacy in our Lambda function in `src/lambda/index.js` points to. Create the new bucket (named `allaboutpets-stacy` in our example) and in the permissions section of the bucket properties, add a new bucket policy:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Principal": {
				"AWS": "arn:aws:iam::xxx:role/stacy"
			},
			"Action": [
				"s3:GetObject",
				"s3:GetObjectVersion",
				"s3:PutObject"
			],
			"Resource": "arn:aws:s3:::allaboutpets-stacy/*"
		},
		{
			"Effect": "Allow",
			"Principal": {
				"AWS": "arn:aws:iam::xxx:role/stacy"
			},
			"Action": "s3:ListBucket",
			"Resource": "arn:aws:s3:::allaboutpets-stacy"
		}
	]
}
```

Replace the principal ARNs in the example above with your stacy role ARN and the resource ARNs with your bucket ARN.

Now, upload the site configuration file into the bucket under name `allaboutpets-config.json` (replace "allaboutpets" with your actual site id):

```json
{
  "contentMetaS3Bucket": "allaboutpets-stacy",
  "contentfulSpaceId": "<your Contentful space id>",
  "contentfulAPIKey": "<your Contentful API key>",
  "contentS3Bucket": "allaboutpets-website",
  "maxDepth": 2
}
```

The site configuration file name is always formed using pattern `<site id>-config.json` and the possible configuration parameters are:

* `contentfulSpaceId` *(required)* - Id of the Contentful space with the site's content.

* `contentfulAPIKey` *(required)* - Contentful API key. Stacy uses it to make calls to the Contentful Content Delivery API.

* `contentMetaS3Bucket` *(required)* - Name of the S3 bucket used by Stacy to store a JSON file containing the site content metadata. The file is maintained by Stacy automatically and describes the relationships between different content entries, maps asset ids to the file names, etc. The default name of the file follows pattern `<site id>-content-meta.json` and can be overridden by the `contentMetaS3Key` optional site configuration property. In this guide, we use the same bucket for the site configuration and the site content metadata, but it does not have to be the same.

* `contentMetaS3Key` *(optional)* - Name of the site content metadata JSON file. The default is `<site id>-content-meta.json`.

* `contentS3Bucket` *(required)* - Name of the S3 bucket, from which the website is served. This is where the Lambda function publishes the compiled pages and assets.

* `assetsFolder` *(optional)* - Name of the folder under the `contentS3Bucket` where the assets are published. All Contentful assets are published in this single folder using their corresponding file names. The default value is "assets".

* `maxDepth` *(optional)* - Maximum number of nested references in the website's Contentful content. The default is 3 (meaning a top page can include another entry, which in turn can include one more).

* `pageContentTypes` *(optional)* - An array with Contentful content type ids that are top pages. Entries of other content types can be modules included in the pages or other modules, but only entries with the listed content types generate HTML files (that is pages). When an entry is published, using site content meta-data Stacy determines what pages are affected and regenerates those pages. Unpublishing an entry that is not a page has no effect, but may break the affected pages when regenerated later as the unpublished entries become unavailable in the Content Delivery API. Authors must keep that in mind and make sure that the top level page entry is explicitly unpublished for the page to be removed from the site. The default value of the property is an array with a single content type id "page".

* `pageSlugFieldName` *(optional)* - Name of the page content type (any content type listed in `pageContentTypes`) field that contains the page slug. The page slug is the published page HTML file name without the ".html" suffix (for example "index", "products", "about", etc.).

### The Lambda Function

The infrastructure is ready now for us to upload the Lambda function. Use Gulp to build the Lambda package file and find it under `dist/lambda.zip`. In the AWS Management Console go to the Lambda service and create a new function (skipping the blueprint). For function trigger pick Kinesis, select the stream and enable the trigger:

![API Screenshot](https://raw.githubusercontent.com/boylesoftware/stacy/master/docs/img/lambda1_screenshot.png)

In the next screen, select the function name (for example "stacy"), Node.js 4.3 as the Runtime, upload a .ZIP file as Code entry type and select the compiled zip file as the Function package, leave `index.handler` as the Handler, enter stacy as the Role name, leave Memory at 128MB (the minimum), increase timeout to something like 10 seconds (Stacy performs quite a lot of input/output), and leave No VPC.

After the function is deployed, the AWS infrastructure setup is complete.

## The Contentful Space

Finally, we need to setup our Contentful space. It includes two parts: defining the content types to match the templates and setting up the webhook to deliver content update events to Stacy. Let's start with the content types.

### The Content Types

In the Content Model we need to define two content types: one for the page and one for the post. Let's start with the post. When creating it, make sure that the API identifier is `post` (remember, it must match the template name). Then start adding fields:

* `caption` - Short text.
* `picture` - Media, one file.
* `content` - Long text.

Now, we can define the `page` content type with fields:

* `title` - Short text.
* `posts` - Reference, many references.
* `slug` - Short text (required and unique!).

Don't forget to use validations on the fields to enforce the content structure (for example, the `picture` field can be only an image and the `posts` field can only refer to entries of type `post`).

The `slug` field on the page content type determines the generated HTML file name. For example, if the slug value is `index`, the generated page file in the target S3 bucket will be `index.html`.

### The Webhook

Now, let's configure the webhook. Go to the Settings/Webhooks and hit Add webhook button. Name the webhook "Stacy" (for example), set the URL to your API Gateway endpoint:

```
https://<api id>.execute-api.<region>.amazonaws.com/prod/sites/allaboutpets/content-events
```

And add a custom header named `X-API-Key` with your API Gateway API key. Then select Only selected events option in the Trigger this event for section and check four events: Entry/Publish, Entry/Unpublish, Asset/Publish and Asset/Unpublish. Stacy will ignore any unrecognized events, but there is no need to call the API and the Lambda function for those events (remember, each call incures charges).

That's it! Everything is ready for the content to be created and published.
