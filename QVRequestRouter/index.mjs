import axios, {AxiosHeaders} from "axios";
import xmlJs from 'xml-js';
import {GetParameterCommand} from "@aws-sdk/client-ssm";

import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";

const jsonData = "{\n" +
    "  \"userToHost\": {\n" +
    "    \"qa2vyne@id.economical.com\": \"qa2vyne\",\n" +
    "    \"qa3vyne@id.economical.com\": \"qa3vyne\",\n" +
    "    \"user3\": \"sit1\"\n" +
    "  },\n" +
    "  \"hostToCluster\": {\n" +
    "    \"qa2vyne\": \"dev\",\n" +
    "    \"qa3vyne\": \"dev\",\n" +
    "    \"sit1\": \"qa\"\n" +
    "  },\n" +
    "  \"clusterToOauth\": {\n" +
    "    \"dev\": {\n" +
    "      \"clientId\": \"clientIdDev\",\n" +
    "      \"clientSecret\": \"clientSecretDev\",\n" +
    "      \"scope\": \"scopeDev\",\n" +
    "      \"grantType\": \"grantTypeDev\",\n" +
    "      \"username\": \"oauthUsernameDev\",\n" +
    "      \"password\": \"oauthPasswordDev\"\n" +
    "    },\n" +
    "    \"qa\": {\n" +
    "      \"clientId\": \"clientIdQA\",\n" +
    "      \"clientSecret\": \"clientSecretQA\",\n" +
    "      \"scope\": \"scopeQA\",\n" +
    "      \"grantType\": \"grantTypeQA\",\n" +
    "      \"username\": \"oauthUsernameQA\",\n" +
    "      \"password\": \"oauthPasswordQA\"\n" +
    "    }\n" +
    "  }\n" +
    "}"

async function main(event){
    try {
        const requestHeaders = event.headers || {};
        const requestBody = event.body || {};
        const cleanRequestBody = requestBody.replace('\"', '"');
        const username = await parseXMLAndGetUsername(cleanRequestBody);
        customLogger('info', `Parsed Username: ${username}`);
        //const jsonData = process.env.JSON_DATA; // Retrieve JSON data from environment variable
        const cognitoRequestDetails = await getCognitoTokenRequestDetails(username, jsonData);
        customLogger('info', `Target Host: ${cognitoRequestDetails.hostname}`);
        return await callApiWithRetryOnTokenError(cleanRequestBody, requestHeaders, cognitoRequestDetails);
    } catch (error) {
        customLogger('error', `Lambda Handler Error: ${error}`);
        return {
            statusCode: 500,
            body: JSON.stringify({
                "errorMessage": "Internal Server Error",
                "details": error.message || ''
            }),
            headers: {
                "Content-Type": "application/json"
            }
        };
    }
}

async function parseXMLAndGetUsername(xmlContent) {
    const parsedXml = xmlJs.xml2js(xmlContent, {
        compact: true
    });
    const quoteRequestCDATA = parsedXml['soapenv:Envelope']['soapenv:Body']['ws:getQuoteRequest']['ws:quoteRequest'];
    const cdataContent = quoteRequestCDATA._cdata;
    const quoteRequestXml = xmlJs.xml2js(cdataContent, {
        compact: true
    });
    return quoteRequestXml.ACORD.SignonRq.SignonTransport.CustId.CustPermId._text || undefined;
}

async function callApiWithRetryOnTokenError(xmlContent, requestHeaders, cognitoRequestDetails) {
    try {
        let cognitoToken = await getTokenFromSSM(); // Get Cognito token from Parameter Store
        if (cognitoToken == null || cognitoToken == {}) {
            cognitoToken = await getCognitoToken(cognitoRequestDetails);
            await saveTokenToSSM(cognitoToken)
        }
        const serverResponse = await callResourceServer(xmlContent, requestHeaders, cognitoRequestDetails.username, cognitoRequestDetails.hostname, cognitoToken);
        customLogger('info', `Resource Server Response Status: ${serverResponse.statusCode}`);
        return {
            statusCode: serverResponse.statusCode,
            body: serverResponse.body,
            headers: serverResponse.headers
        };
    } catch (error) {
        /* Retry with new token if token is expired (401 Unauthorized) */
        if (error.response && error.response.status === 401) {
            const cognitoToken = await getCognitoToken();
            requestHeaders.Authorization = `Bearer ${cognitoToken}`;
            const serverResponse = await callResourceServer(xmlContent, requestHeaders, cognitoRequestDetails.username, cognitoRequestDetails.hostname, cognitoToken);
            customLogger('info', `Server Response Status: ${serverResponse.status}`);
            return serverResponse;
        }else if(error.response){
            const response = error.response;

            // Convert AxiosHeaders to a standard object for easy access and logging
            const errorResponse =  {
                statusCode: response.status,
                body: response.data,
                headers: response.headers
            }
            return errorResponse;
        }
        throw error;
    }
}

async function callResourceServer(xmlContent, requestHeaders, username, destinationHost, bearerToken) {
    requestHeaders["Content-Type"] = "application/soap+xml";
    requestHeaders.Authorization = `Bearer ${bearerToken}`;
    const requestOptions = {
        method: "POST",
        url: `https://${destinationHost}.wiremockapi.cloud/quoting-service/microservices/quoting/ws/quoting`,
        headers: requestHeaders,
        data: xmlContent,
        timeout: 30000 // Timeout in milliseconds (30 seconds)
    };
    customLogger('info', `Requesting Resource Server: ${requestOptions.method}: ${requestOptions.url}`);
    const response = await axios(requestOptions);
    const responseHeaders = response.headers || {};
    responseHeaders["x-routed-username"] = username;
    responseHeaders["x-response-host"] = destinationHost;
    return {
        statusCode: response.status,
        body: response.data,
        headers: responseHeaders
    };
}

async function getCognitoToken(cognitoRequestDetails) {
    try {
        const formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');

        const requestOptions = {
            method: 'POST',
            url: `https://${cognitoRequestDetails.hostname}.wiremockapi.cloud/user-token`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': "Basic " + Buffer.from(`${cognitoRequestDetails.oauthClientDetails.clientId}:${cognitoRequestDetails.oauthClientDetails.password}`, "utf-8")
                    .toString('base64'),
                'username': cognitoRequestDetails.oauthClientDetails.username,
                'password': cognitoRequestDetails.oauthClientDetails.password
            },
            data: formData,
            timeout: 10000 // Timeout in milliseconds (10 seconds)
        };
        customLogger('info', `Requesting Token Server: ${requestOptions.method}: ${requestOptions.url}`);
        const response = await axios(requestOptions);
        customLogger('info', `Response from Token Server: ${JSON.stringify(response.data)}`);
        return response.data.access_token;
    } catch (error) {
        customLogger('error', `Failed to obtain Cognito token: ${error}`);
        throw error;
    }
}

// Function to save the Cognito token in AWS SSM Parameter Store
async function saveTokenToSSM(token, expiresIn) {
    try{
        // Initialize AWS SDK with the correct region and HTTP client configuration
        const ssmClient = new SSMClient({
            region: 'ca-central-1',
            requestHandler: new NodeHttpHandler({
                requestTimeout: 5000 // Set request timeout to 5 seconds (adjust as needed)
            })
        });

        const expirationTimestamp = Math.floor(Date.now() / 1000) + expiresIn; // Calculate the expiration time in seconds
        const params = {
            Name: 'cognito_access_token', // Unique and descriptive parameter name
            Value: JSON.stringify({
                token,
                expirationTimestamp
            }), // Store token and expiration timestamp
            Type: 'SecureString', // Store as SecureString for encryption
            Overwrite: true // Overwrite existing parameter if exists
        };

        await ssmClient.send(new PutParameterCommand(params)); // Save the token to Parameter Store
    } catch (error) {
        customLogger('warn', `Failed to save Cognito token: ${error}`);
    }
}

// Function to get the Cognito token from AWS SSM Parameter Store
async function getTokenFromSSM() {
    try {
        const ssmClient = new SSMClient({
            region: 'ca-central-1',
            requestHandler: new NodeHttpHandler({
                requestTimeout: 5000 // Set request timeout to 5 seconds (adjust as needed)
            })
        });

        const params = {
            Name: 'cognito_access_token',
            WithDecryption: true
        };

        const response = await ssmClient.send(new GetParameterCommand(params));
        if (response == null || response == {}){
            return null
        }else {
            // Parse token and expiration timestamp
            const parsedData = JSON.parse(response.Parameter.Value);
            const expirationTimestamp = parsedData.expirationTimestamp;

            // Check if token is not expired
            const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
            if (currentTime < expirationTimestamp) {
                return parsedData.token;
            } else{
                return null;
            }
        }
    } catch (error) {
        customLogger('warn', `Failed to get or refresh token from SSM: ${error}`);
        return null;
    }
}

// Function to retrieve details for a specific user
async function getCognitoTokenRequestDetails(username, data) {
    const userData = JSON.parse(data);
    const hostname = userData.userToHost[username];
    const cluster = userData.hostToCluster[hostname];
    const oauthDetails = userData.clusterToOauth[cluster];
    if (!oauthDetails) {
        throw new Error(`OAuth details not found for cluster: ${cluster}`);
    }
    return {
        username,
        hostname,
        cluster,
        oauthClientDetails: {
            clientId: oauthDetails.clientId,
            clientSecret: oauthDetails.clientSecret,
            scope: oauthDetails.scope,
            grantType: oauthDetails.grantType,
            username: oauthDetails.username,
            password: oauthDetails.password
        }
    };
}

const logLevel = process.env.LOG_LEVEL || 'info';

function customLogger(level, message) {
    const levels = ['debug', 'info', 'warn', 'error'];
    const levelIndex = levels.indexOf(level);
    const envLevelIndex = levels.indexOf(logLevel);
    if (levelIndex >= envLevelIndex) {
        const timestamp = new Date().toISOString();
        const pid = process.pid; // Again, less useful in Lambda
        console.log(`${timestamp} [${pid}] ${level.toUpperCase()} - ${message}`);
    }
}

const event = {
    "body": "<?xml version=\"1.0\" encoding=\"utf-8\"?><soapenv:Envelope xmlns:soapenv=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:wsse=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\" xmlns:wsu=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:ws=\"http://economicalinsurance.com/quoting/ws/\"><soapenv:Header></soapenv:Header><soapenv:Body><ws:getQuoteRequest><ws:format>CSIO</ws:format><ws:version>1.33</ws:version><ws:source>QV_APPLIED</ws:source><ws:username>broker2</ws:username><ws:quoteRequest><![CDATA[<ACORD xmlns=\"http://www.ACORD.org/standards/PC_Surety/ACORD1/xml/\" xmlns:csio=\"http://www.CSIO.org/standards/PC_Surety/CSIO1/xml/\" xmlns:lang=\"http://www.w3.org/XML/1998/namespace/\"><SignonRq><SignonTransport><CustId><SPName>ECON</SPName><CustPermId>qa2vyne@id.economical.com</CustPermId></CustId></SignonTransport><ClientDt>2024-02-09T13:08:04-05:00</ClientDt><CustLangPref>EN</CustLangPref><ClientApp><Org>Applied Systems</Org><Name>Rating Services</Name><Version>1.0</Version></ClientApp></SignonRq><InsuranceSvcRq><RqUID>da688bf9-7590-4056-82bb-33d6a142eb34</RqUID></InsuranceSvcRq></ACORD>]]></ws:quoteRequest></ws:getQuoteRequest></soapenv:Body></soapenv:Envelope> "
}

console.log(await main(event));

/*//Lambda function handler
export const handler = async (event, context) => {
    return await main(event);
};*/