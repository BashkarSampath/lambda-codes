import axios from "axios";
import xmljs from 'xml-js';

export const handler = async (event, context) => {
    try {
        // Get the request context from the event
        const requestHeaders = event.headers || {};
        const requestBody = event.body;
        const requestMethod = event.httpMethod;
        const resourcePath = event.resource;
        const requestPath = event.path;
        
        const username = parseXMLForUsername(requestBody);
        const destinationUrl = mapDestinationByUsername(username);
    
        // Define the options for the request to the destination server
        const requestOptions = {
            method: requestMethod,
            url: `${destinationUrl}`,
            headers: requestHeaders,
            data: requestBody
        };

        // Make the request to the destination server using Axios
        const response = await axios(requestOptions);

        // Return the response from the destination server to the original client
        const responseHeaders = response.headers || {};
        responseHeaders["x-response-host"] = destinationUrl;

        const lambdaResponse = {
            statusCode: response.status,
            body: response.data,
            headers: responseHeaders
        };

        return lambdaResponse;
    } catch (error) {
        console.error('Error occurred:', error);
        let statusCode = 500; // Default status code
    
        // Check if the error object has a status code property
        if (error.response && error.response.status) {
            statusCode = error.response.status;
        } else if (error.statusCode) {
            statusCode = error.statusCode;
        }
    
        const errorMessage = error.message || 'Internal Server Error';
        const errorStack = error.stack || '';
    
        const lambdaResponse = {
            statusCode: statusCode,
            body: JSON.stringify({ 
                error: errorMessage,
                stack: errorStack 
            }),
            headers: {
                'Content-Type': 'application/json'
            }
        };
    
        return lambdaResponse;
    }
};

function parseXMLForUsername(xmlContent){
    // Parse XML content
    const parsedXml = xmljs.xml2js(xmlContent, { compact: true });
    // Access CDATA content of ws:quoteRequest
    const quoteRequestCDATA = parsedXml['soapenv:Envelope']['soapenv:Body']['ws:getQuoteRequest']['ws:quoteRequest'];
    // Extract the CDATA content
    const cdataContent = quoteRequestCDATA._cdata;
    // Parse the CDATA content separately
    const quoteRequestXml = xmljs.xml2js(cdataContent, { compact: true });
    // Access elements from the parsed CDATA content
    const custPermId = quoteRequestXml.ACORD.SignonRq.SignonTransport.CustId.CustPermId._text;
    // Return the custPermId
    return custPermId;
}

function mapDestinationByUsername(username){
    if(username == '9Z8@id.bk.com'){
        return "https://dzd5e.wiremockapi.cloud/dev/getEnv";
    }
    else{
        return "https://dzd5e.wiremockapi.cloud/qa/getEnv";
    }
}