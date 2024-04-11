import axios from "axios";
import xmljs from 'xml-js';

export const handler = async (event, context) => {
    const requestBody = event.body || {};
    const cleanRequestBody = requestBody.replace('\"', '"');
    const username = parseXMLAndGetUsername(cleanRequestBody);
    const destinationHost = getDestinationHostByUsername(username);

    // set the correct content-type & endpoint for quoting service
    const requestHeaders = event.headers || {};
    requestHeaders["Content-Type"] = "application/soap+xml";

    // Define the options for the request to the destination server
    const requestOptions = {
        method: "POST",
        url: `https://${destinationHost}/quoting-service/microservices/quoting/ws/quoting`,
        headers: requestHeaders,
        data: cleanRequestBody
    };

    try {
        // Make the request to the destination server using Axios
        const response = await axios(requestOptions);

        // Return the response from the destination server to the original client
        const responseHeaders = response.headers || {};
        responseHeaders["x-response-host"] = destinationHost;
        responseHeaders["x-routed-username"] = username;

        const lambdaResponse = {
            statusCode: response.status,
            body: response.data,
            headers: responseHeaders
        };

        return lambdaResponse;
    } catch (error) {
        console.error('Error occurred:', error);

        // Check if the error object has a status code property
        var statusCode = 500;
        if (error.response && error.response.status) {
            statusCode = error.response.status;
        } else if (error.statusCode) {
            statusCode = error.statusCode;
        }

        const errorMessage = error.message || 'Internal Server Error';
        const errorStack = error.stack || '';

        // Return the response from the destination server to the original client
        const errorResponseHeaders = {};
        errorResponseHeaders["Content-Type"] = "application/text";
        errorResponseHeaders["x-response-host"] = destinationHost;
        errorResponseHeaders["x-routed-username"] = username;

        const lambdaResponse = {
            statusCode: statusCode,
            body: JSON.stringify({
                "errorMessage": errorMessage,
                "details": errorStack
            }),
            headers: errorResponseHeaders
        };

        return lambdaResponse;
    }
};

function parseXMLAndGetUsername(xmlContent) {
    // Parse XML content
    const parsedXml = xmljs.xml2js(xmlContent, {
        compact: true
    });
    // Access CDATA content of ws:quoteRequest
    const quoteRequestCDATA = parsedXml['soapenv:Envelope']['soapenv:Body']['ws:getQuoteRequest']['ws:quoteRequest'];
    // Extract the CDATA content
    const cdataContent = quoteRequestCDATA._cdata;
    // Parse the CDATA content separately
    const quoteRequestXml = xmljs.xml2js(cdataContent, {
        compact: true
    });
    // Access elements from the parsed CDATA content
    const custPermId = quoteRequestXml.ACORD.SignonRq.SignonTransport.CustId.CustPermId._text;
    // Return the custPermId
    return custPermId;
}

function getDestinationHostByUsername(username) {
    if (username == "qa2vyne@id.economical.com") {
        return "qa2vyne.wiremockapi.cloud";
    } else if (username == "qa3vyne@id.economical.com") {
        return "qa3vyne.wiremockapi.cloud"
    } else {
        return "sit1.wiremockapi.cloud";
    }
}