#!/bin/sh
#
# AWS infrastructure setup script for Stacy.
#
# author: Lev Himmelfarb
#

#
# Determine the script base directory.
#
curdir=`pwd`
cd "`dirname \"$0\"`"
BASE=`pwd`
cd "$curdir"

#
# Load configuration.
#
. "$BASE"/config.sh

#
# Define document template processing procedure.
#
process_document() {

	awk '{
		line = $0;
		while (match(line, "\\{\\{[^}]+\\}\\}") > 0) {
			line = substr(line, 1, RSTART - 1) ENVIRON[substr(line, RSTART + 2, RLENGTH - 4)] substr(line, RSTART + RLENGTH);
		}
		print line;
	}' "$1"
	if [ $? != 0 ]; then
		echo "FATAL ERROR" >&2
		exit 255
	fi
}

#
# Load last run state, if any.
#
if [ -f "$BASE"/state.sh ]; then
	. "$BASE"/state.sh
fi

#
# Create Kinesis stream.
#
echo "$STEPS" | grep -q ':KINESIS_STREAM:'
if [ $? = 0 ]; then
	echo "skipping Kinesis stream creation, using stream $KINESIS_STREAM_ARN"
else
	printf "Kinesis stream name [stacy]: "
	read KINESIS_STREAM_NAME
	if [ -z "$KINESIS_STREAM_NAME" ]; then
		KINESIS_STREAM_NAME="stacy"
	fi
	printf "Kinesis stream shard count [1]: "
	read KINESIS_STREAM_SHARD_COUNT
	if [ -z "$KINESIS_STREAM_SHARD_COUNT" ]; then
		KINESIS_STREAM_SHARD_COUNT=1
	fi
	printf "creating Kinesis stream..."
	aws kinesis create-stream --stream-name "$KINESIS_STREAM_NAME" --shard-count "$KINESIS_STREAM_SHARD_COUNT"
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	printf "\nwaiting for Kinesis stream to become active..."
	aws kinesis wait stream-exists --stream-name "$KINESIS_STREAM_NAME"
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	printf "\nquerying Kinesis stream info..."
	resp=`aws kinesis describe-stream --stream-name "$KINESIS_STREAM_NAME"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	KINESIS_STREAM_ARN=`echo "$resp" | grep -m 1 -e '"StreamARN"\s*:' | sed 's/.*"StreamARN"\s*:\s*"\([^"]*\)".*/\1/'`
	printf "\ncreated Kinesis stream with ARN $KINESIS_STREAM_ARN\n"
	echo "KINESIS_STREAM_ARN='$KINESIS_STREAM_ARN'" >> "$BASE"/state.sh
	echo "STEPS=\"$STEPS:KINESIS_STREAM:\"" >> "$BASE"/state.sh
fi
export KINESIS_STREAM_ARN

#
# Create IAM role.
#
echo "$STEPS" | grep -q ':IAM_ROLE:'
if [ $? = 0 ]; then
	echo "skipping IAM role creation, using role $IAM_ROLE_ARN"
else
	printf "IAM role name [stacy]: "
	read IAM_ROLE_NAME
	if [ -z "$IAM_ROLE_NAME" ]; then
		IAM_ROLE_NAME="stacy"
	fi
	doc=`process_document "$BASE"/resources/stacy-assume-role-policy.json`
	printf "creating IAM role..."
	resp=`aws iam create-role --role-name "$IAM_ROLE_NAME" --assume-role-policy-document "$doc"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	IAM_ROLE_ARN=`echo "$resp" | grep -m 1 -e '"Arn"\s*:' | sed 's/.*"Arn"\s*:\s*"\([^"]*\)".*/\1/'`
	printf "\ncreated IAM role with ARN $IAM_ROLE_ARN\n"
	echo "IAM_ROLE_ARN='$IAM_ROLE_ARN'" >> "$BASE"/state.sh
	echo "STEPS=\"$STEPS:IAM_ROLE:\"" >> "$BASE"/state.sh
fi
export IAM_ROLE_ARN

#
# Create API Gateway API.
#
echo "$STEPS" | grep -q ':APIGATEWAY_API:'
if [ $? = 0 ]; then
	echo "skipping API Gateway API creation, using API $APIGATEWAY_API_ID"
else
	printf "API Gateway API name [stacy]: "
	read APIGATEWAY_API_NAME
	if [ -z "$APIGATEWAY_API_NAME" ]; then
		APIGATEWAY_API_NAME="stacy"
	fi
	printf "creating API Gateway API..."
	resp=`aws apigateway create-rest-api --name "$APIGATEWAY_API_NAME"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	APIGATEWAY_API_ID=`echo "$resp" | grep -m 1 -e '"id"\s*:' | sed 's/.*"id"\s*:\s*"\([^"]*\)".*/\1/'`
	printf "\ncreated API Gateway API with id $APIGATEWAY_API_ID\n"
	echo "APIGATEWAY_API_ID='$APIGATEWAY_API_ID'" >> "$BASE"/state.sh
	echo "STEPS=\"$STEPS:APIGATEWAY_API:\"" >> "$BASE"/state.sh
fi
export APIGATEWAY_API_ID

#
# Create API Gateway resource.
#
echo "$STEPS" | grep -q ':APIGATEWAY_RESOURCE:'
if [ $? = 0 ]; then
	echo "skipping API Gateway resource creation, using resource $APIGATEWAY_RESOURCE_ID"
else
	printf "getting API Gateway root resource id..."
	resp=`aws apigateway get-resources --rest-api-id "$APIGATEWAY_API_ID" --query 'items[?path==\`/\`]'`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	parent_resource_id=`echo "$resp" | grep -m 1 -e '"id"\s*:' | sed 's/.*"id"\s*:\s*"\([^"]*\)".*/\1/'`
	path_parts="sites {site} content-events"
	full_path="/"
	for path_part in $path_parts; do
		if [ "$full_path" = "/" ]; then
			full_path="$full_path$path_part"
		else
			full_path="$full_path/$path_part"
		fi
		printf "\ncreating API Gateway resource $full_path..."
		resp=`aws apigateway create-resource --rest-api-id "$APIGATEWAY_API_ID" --parent-id "$parent_resource_id" --path-part "$path_part"`
		if [ $? != 0 ]; then
			echo
			echo "FATAL ERROR" >&2
			exit 255
		fi
		echo ">>> `date`: $resp" >> "$BASE"/responses.log
		parent_resource_id=`echo "$resp" | grep -m 1 -e '"id"\s*:' | sed 's/.*"id"\s*:\s*"\([^"]*\)".*/\1/'`
	done
	APIGATEWAY_RESOURCE_ID="$parent_resource_id"
	printf "\nadding API Gateway resource method..."
	resp=`aws apigateway put-method --rest-api-id "$APIGATEWAY_API_ID" --resource-id "$APIGATEWAY_RESOURCE_ID" --http-method "POST" --authorization-type "NONE" --api-key-required --request-parameters "method.request.header.X-Contentful-Topic=true"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	printf "\nadding API Gateway method 200 response..."
	resp=`aws apigateway put-method-response --rest-api-id "$APIGATEWAY_API_ID" --resource-id "$APIGATEWAY_RESOURCE_ID" --http-method "POST" --status-code "200" --response-models "{\"application/json\":\"Empty\"}"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	printf "\nadding API Gateway method 500 response..."
	resp=`aws apigateway put-method-response --rest-api-id "$APIGATEWAY_API_ID" --resource-id "$APIGATEWAY_RESOURCE_ID" --http-method "POST" --status-code "500" --response-models "{\"application/json\":\"Empty\"}"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	printf "\nadding API Gateway resource integration..."
	stream_region=`echo "$KINESIS_STREAM_ARN" | cut -d ':' -f 4`
	request_templates="{\"application/vnd.contentful.management.v1+json\": \"#set(\$rec = \\\"{\n    \\\"\\\"site\\\"\\\": \\\"\\\"\$input.params('site')\\\"\\\",\n    \\\"\\\"topic\\\"\\\": \\\"\\\"\$input.params('X-Contentful-Topic')\\\"\\\",\n    \\\"\\\"payload\\\"\\\": \$input.json('\$')\n}\\\")\n{\n    \\\"StreamName\\\": \\\"\$stageVariables.streamName\\\",\n    \\\"PartitionKey\\\": \\\"\$input.params('site')\\\",\n    \\\"Data\\\": \\\"\$util.base64Encode(\$rec)\\\"\n}\"}"
	resp=`aws apigateway put-integration --rest-api-id "$APIGATEWAY_API_ID" --resource-id "$APIGATEWAY_RESOURCE_ID" --http-method "POST" --type "AWS" --integration-http-method "POST" --uri "arn:aws:apigateway:$stream_region:kinesis:action/PutRecord" --credentials "$IAM_ROLE_ARN" --request-parameters "{\"integration.request.header.Content-Type\":\"'application/x-amz-json-1.1'\"}" --request-templates "$request_templates" --passthrough-behavior "NEVER"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	printf "\nadding API Gateway resource 200 response integration..."
	resp=`aws apigateway put-integration-response --rest-api-id "$APIGATEWAY_API_ID" --resource-id "$APIGATEWAY_RESOURCE_ID" --http-method "POST" --status-code "200" --selection-pattern ""`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	printf "\nadding API Gateway resource 500 response integration..."
	resp=`aws apigateway put-integration-response --rest-api-id "$APIGATEWAY_API_ID" --resource-id "$APIGATEWAY_RESOURCE_ID" --http-method "POST" --status-code "500" --selection-pattern '[^2].*'`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	printf "\nadding API Gateway deployment..."
	stream_name=`echo "$KINESIS_STREAM_ARN" | sed 's/.*\/\([^\/]*\)$/\1/'`
	resp=`aws apigateway create-deployment --rest-api-id "$APIGATEWAY_API_ID" --stage-name "prod" --variables "streamName=$stream_name"`
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	echo ">>> `date`: $resp" >> "$BASE"/responses.log
	#deployment_id=`echo "$resp" | grep -m 1 -e '"id"\s*:' | sed 's/.*"id"\s*:\s*"\([^"]*\)".*/\1/'`
	printf "\ncreated API Gateway content events resource with id $APIGATEWAY_RESOURCE_ID\n"
	echo "APIGATEWAY_RESOURCE_ID='$APIGATEWAY_RESOURCE_ID'" >> "$BASE"/state.sh
	echo "STEPS=\"$STEPS:APIGATEWAY_RESOURCE:\"" >> "$BASE"/state.sh
fi
export APIGATEWAY_RESOURCE_ID

#
# Add IAM role policy.
#
echo "$STEPS" | grep -q ':IAM_ROLE_POLICY:'
if [ $? = 0 ]; then
	echo "skipping IAM role policy creation"
else
	doc=`process_document "$BASE"/resources/stacy-role-policy.json`
	printf "creating IAM role policy..."
	role_name=`echo "$IAM_ROLE_ARN" | sed 's/.*\/\([^\/]*\)$/\1/'`
	aws iam put-role-policy --role-name "$role_name" --policy-name "Stacy" --policy-document "$doc"
	if [ $? != 0 ]; then
		echo
		echo "FATAL ERROR" >&2
		exit 255
	fi
	printf "\ncreated IAM role policy\n"
	echo "STEPS=\"$STEPS:IAM_ROLE_POLICY:\"" >> "$BASE"/state.sh
fi

#
# Done.
#
echo "done."
