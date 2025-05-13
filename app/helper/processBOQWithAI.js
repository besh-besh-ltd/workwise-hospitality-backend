import axios from 'axios';
import productModel from '../models/productModel.js';
import { logError } from './common.js';
import s3Client from '../config/s3config.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import pkg from 'nodemailer/lib/xoauth2/index.js';
const { Readable } = pkg;
import fs from 'fs';
import FormData from 'form-data';
import path from 'path';
import pdfParser from './pdfParser.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const generativeAI = {
  extractClauses: async (file, productName = null) => {
    console.log(`[processBOQWithAI.js] Entering extractClauses. ProductName: ${productName}, File: ${file ? file.originalname || file.filename : 'No file info'}`);
    try {
      let buffer;
      if (file.location) {
        console.log(`[processBOQWithAI.js] extractClauses: File is in S3. Location: ${file.location}`);
        const s3Url = new URL(file.location);
        const bucket = s3Url.hostname.split('.')[0];
        const key = decodeURIComponent(s3Url.pathname).slice(1);
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const result = await s3Client.send(command);
        const webStream = Readable.toWeb(result.Body);
        const response = new Response(webStream);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
        console.log('[processBOQWithAI.js] extractClauses: Buffer created from S3 file.');
      } else if (file.path) {
        console.log(`[processBOQWithAI.js] extractClauses: File is locally uploaded. Path: ${file.path}`);
        buffer = fs.readFileSync(file.path);
        console.log('[processBOQWithAI.js] extractClauses: Buffer created from local file.');
      } else if (file.buffer) {
        console.log('[processBOQWithAI.js] extractClauses: File is already a buffer.');
        buffer = file.buffer;
      } else {
        console.error('[processBOQWithAI.js] extractClauses: Invalid file format or location.');
        throw new Error('Invalid file format or location');
      }

      const fileExt = path.extname(file.originalname || file.filename).toLowerCase();
      console.log(`[processBOQWithAI.js] extractClauses: File extension: ${fileExt}`);
      
      if (fileExt === '.pdf') {
        try {
          console.log('[processBOQWithAI.js] extractClauses: Starting PDF processing.');
          const pdfText = await pdfParser.extractText(buffer);
          const cleanedText = pdfParser.cleanText(pdfText);
          console.log(`[processBOQWithAI.js] extractClauses: PDF text extracted and cleaned. Cleaned text length: ${cleanedText.length}`);

          const apiKey = process.env.GOOGLE_AI_API_KEY;
          if (!apiKey) {
            console.error('[processBOQWithAI.js] extractClauses: Google AI API Key is not configured.');
            throw new Error('Google AI API Key is not configured');
          }

          const genAI = new GoogleGenerativeAI(apiKey);
          const modelName = 'gemini-1.5-flash-latest'; // Reverted for stability
          console.log(`[processBOQWithAI.js] extractClauses: Initializing Google Generative AI with model: ${modelName}`);
          const model = genAI.getGenerativeModel({ model: modelName });

          let prompt;
          if (productName) {
            console.log(`[processBOQWithAI.js] extractClauses: Generating prompt for ProductName: ${productName}`);
            prompt = `
              You are an AI trained to extract comprehensive information from documents for a specific product.
              
              TARGET PRODUCT: "${productName}"
              
              **IMPORTANT FIRST STEP:** Before extracting any information, first assess if the overall document content is contextually relevant to the TARGET PRODUCT: "${productName}". 
              - Contextual relevance means the document is primarily about the product or a very closely related concept. 
              - For example, if the TARGET PRODUCT is 'flow meter', a document about 'flow gauge' or 'flow transmitter' IS contextually relevant.
              - However, if the TARGET PRODUCT is 'flow meter', a document primarily about 'flanges', 'pipes', or 'valves' IS NOT contextually relevant.
              
              **IF THE DOCUMENT IS NOT CONTEXTUALLY RELEVANT TO THE TARGET PRODUCT, YOU MUST RETURN AN EMPTY "clauses" array in the JSON output like this: { "clauses": [] }. Do not proceed with extraction.**
              
              **IF AND ONLY IF the document IS contextually relevant**, proceed to extract ALL of the following information related to "${productName}" from the document:
              
              1. TECHNICAL INFORMATION:
                - Technical specifications (dimensions, materials, performance parameters)
                - Engineering requirements and constraints
                - Operational parameters and restrictions
                - Installation requirements and procedures
              
              2. COMPLIANCE AND STANDARDS:
                - Industry standards and certifications required
                - Regulatory compliance requirements
                - Testing protocols and acceptance criteria
                - Quality assurance requirements
              
              3. COMMERCIAL AND CONTRACT TERMS:
                - Delivery terms and conditions
                - Warranty provisions
                - Liability clauses
                - Payment and pricing details
              
              4. GENERAL NOTES AND CONDITIONS:
                - Important notes about the product
                - Special handling requirements
                - Environmental constraints or considerations
                - Any other general information or warnings
              
              5. INSPECTION AND TESTING:
                - Inspection procedures
                - Test requirements
                - Quality control measures
                - Acceptance tests and criteria
              
              6. OTHER RELEVANT INFORMATION:
                - Any other clauses or information that might be important
                - Special requirements or exceptions
                - Notes about product supply or usage
              
              CRITICALLY IMPORTANT INSTRUCTIONS (Apply ONLY if the document is relevant):
              - Maintain the EXACT hierarchical structure and formatting of all information
              - Preserve ALL numbered or bulleted lists exactly as they appear
              - Keep ALL tables, measurements and numerical values with their units intact
              - Include ALL conditional statements and logical relationships
              - Capture information even if "${productName}" is not explicitly mentioned but context makes it clear it relates to the target product.
              - DO NOT rephrase, interpret, or summarize - use the EXACT ORIGINAL text
              - Capture information even if it spans across different pages/sections
              - Pay special attention to footnotes, references, and fine print
              - Preserve cross-references between sections
              - Identify text that applies generally vs. specifically to "${productName}"
              
              Return the data in a JSON format with the following structure:
              { 
                "clauses": [
                  { "text": "complete original clause or specification text" } 
                  // This array should be empty if the document was determined to be not contextually relevant in the first step.
                ]
              }
              
              Here is the document content:
              ${cleanedText}
            `;
          } else {
            console.log('[processBOQWithAI.js] extractClauses: Generating general prompt (no productName).');
            prompt = `
              You are an AI trained to extract comprehensive information from documents.
              
              Extract ALL of the following information categories from the document:
              
              1. TECHNICAL INFORMATION:
                - Technical specifications and requirements
                - Engineering parameters and constraints
                - Operational requirements and limitations
                - Installation specifications and procedures
              
              2. COMPLIANCE AND STANDARDS:
                - Industry standards and certifications
                - Regulatory compliance requirements
                - Testing protocols and acceptance criteria
                - Quality assurance requirements
              
              3. COMMERCIAL AND CONTRACT TERMS:
                - Delivery terms and conditions
                - Warranty provisions and limitations
                - Liability clauses and exceptions
                - Payment terms and pricing details
              
              4. GENERAL NOTES AND CONDITIONS:
                - Important notes about products or services
                - Special handling or storage requirements
                - Environmental constraints or considerations
                - Any other general information or warnings
              
              5. INSPECTION AND TESTING:
                - Inspection procedures and requirements
                - Test methods and parameters
                - Quality control measures and criteria
                - Acceptance tests and verification procedures
              
              6. OTHER RELEVANT INFORMATION:
                - Any other clauses or information that might be important
                - Special requirements or exceptions
                - Notes about product supply, usage, or implementation
              
              CRITICALLY IMPORTANT INSTRUCTIONS:
              - Maintain the EXACT hierarchical structure and formatting
              - Preserve ALL numbered or bulleted lists exactly as they appear
              - Keep ALL tables, measurements and numerical values with their units intact
              - Include ALL conditional statements and logical relationships
              - DO NOT rephrase, interpret, or summarize - use the EXACT ORIGINAL text
              - Preserve section headings and their relationships to content
              - Maintain all cross-references between sections
              - Capture all footnotes, references, and fine print
              
              Return the data in a JSON format with the following structure:
              { 
                "clauses": [
                  { "text": "complete original clause or specification text" }
                ]
              }
              
              Here is the document content:
              ${cleanedText}
            `;
          }

          console.log('[processBOQWithAI.js] extractClauses: Calling Generative AI model...');
          const resultFromAI = await model.generateContent(prompt);
          
          const textFromAI = resultFromAI.response ? resultFromAI.response.text() : 
                             (typeof resultFromAI.text === 'function' ? resultFromAI.text() : 
                             (resultFromAI.text || JSON.stringify(resultFromAI)));
          console.log('[processBOQWithAI.js] extractClauses: Received response from AI.'); // Avoid logging full textFromAI if too large
          // console.log(`[processBOQWithAI.js] extractClauses: AI Response Text (raw):\n${textFromAI.substring(0, 500)}...`);

          const jsonMatch = textFromAI.match(/```json\n([\s\S]*?)\n```/) || 
                          textFromAI.match(/```\n([\s\S]*?)\n```/) || 
                          textFromAI.match(/{[\s\S]*?}/);
                          
          if (jsonMatch) {
            console.log('[processBOQWithAI.js] extractClauses: JSON block found in AI response.');
            try {
              const jsonStr = jsonMatch[1] || jsonMatch[0];
              const extractedData = JSON.parse(jsonStr);
              console.log('[processBOQWithAI.js] extractClauses: Successfully parsed JSON from AI response.');
              return {
                status: 1,
                message: productName 
                  ? `Comprehensive information extracted successfully for ${productName}`
                  : 'Comprehensive information extracted successfully',
                clauses: extractedData.clauses ? extractedData.clauses.map(clause => clause.text) : [] // Ensure clauses array exists
              };
            } catch (parseError) {
              console.error('[processBOQWithAI.js] extractClauses: Error parsing JSON from Gemini response:', parseError.message, 'Raw JSON string attempt:', jsonMatch[1] || jsonMatch[0]);
              return { status: 0, message: 'Failed to parse structured data from AI', error: parseError.message, clauses: [] };
            }
          } else {
            console.warn('[processBOQWithAI.js] extractClauses: No JSON block found in AI response. Attempting manual line extraction.', `First 500 chars of AI response: ${textFromAI.substring(0,500)}`);
            const lines = textFromAI.split('\n').filter(line => line.trim().length > 0);
            const potentialClauses = lines.filter(line => line.length > 20 && !line.includes('```') && !line.startsWith('Here') && !line.startsWith('I will'));
            return {
              status: 1,
              message: productName 
                ? `Information extracted (fallback) for ${productName}`
                : 'Information extracted (fallback)',
              clauses: potentialClauses
            };
          }
        } catch (pdfProcessingError) {
          console.error('[processBOQWithAI.js] extractClauses: Error processing PDF with AI:', pdfProcessingError);
          const errorMessage = pdfProcessingError.message || pdfProcessingError.toString();
          return { status: 0, message: 'Error processing PDF with AI', error: errorMessage, clauses: [] };
        }
      } else {
        console.warn(`[processBOQWithAI.js] extractClauses: Unsupported file format: ${fileExt}`);
        throw new Error('Unsupported file format. Please upload PDF files only.');
      }
    } catch (mainError) {
      console.error('[processBOQWithAI.js] extractClauses: Unhandled error in main try-catch:', mainError);
      logError(mainError);
      return { status: 0, message: 'Error processing file with AI', error: mainError.message, clauses: [] };
    }
  },

  processBOQWithAI: async (file) => {
    try {
      const s3Url = new URL(file);
      const bucket = s3Url.hostname.split('.')[0];
      const key = decodeURIComponent(s3Url.pathname).slice(1); // remove leading '/'
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      const result = await s3Client.send(command);
      const webStream = Readable.toWeb(result.Body);
      const ressult2 = new Response(webStream);
      const arrayBuffer = await ressult2.arrayBuffer();   // temporary fix for web stream to array buffer
      const buffer = Buffer.from(arrayBuffer);
      const workbook = xlsx.read(buffer, { type: "buffer" });

      const sheetName = workbook.SheetNames[0]; // Assuming data is in the first sheet
      const sheet = workbook.Sheets[sheetName];
      const boqData = xlsx.utils.sheet_to_csv(sheet);

      // get all terms list
      const uniqueProductList2 = await productModel.getAllProduct(true);
      const uniqueProductList = uniqueProductList2.map(
        (product) => product.name
      );

      const prompt = `
        You are an AI trained to extract product information from unstructured BOQ documents and cross-reference products against a provided database. Your goal is to accurately identify products and match them to the database, even if there are slight variations in naming.
        
        Your tasks:
        
        1. Extract the following details from the provided BOQ text:
          * Product Name: Extract a valid product name. Prioritize descriptive names and use contextual clues from specifications. When an exact match isn't found in the database, consider common abbreviations, pluralizations, and slight variations in wording. Use the specifications to guide your product name extraction. If a product is present in our database, rename the product name to match the *exact* name present in our database. Avoid picking substring matches. If you are unable to find name from BOQ then use the specification column as the product name, only if specification provides a clear product identification.
        
          * Size: Capture specific attributes for product sizes.
          * Specification: Capture all specifications in the current row. If specification for a product is NA then use the last available valid specification if available.
          * Quantity: Always an integer. Ensure that the extracted quantity represents the actual quantity value and not any index, serial number, or unrelated numerical values.
          * Unit: Always a valid measurement unit. If unavailable use NA
        
        2. Cross-reference each extracted product name against the provided product database list:
          * Then, if the product exists in the database (even if the spelling or format differs slightly), rename the extracted product name to match *exactly* the product name from the database and set "productNotFound": false. Prioritize exact matches, then use fuzzy matching with a high similarity threshold.  Look for similar patterns as the examples, such as pluralization differences, abbreviations (e.g., GI), and slight word order variations.
          * If the product does not exist in the database, add an additional key "productNotFound" with value true.
        
        Important Guidelines:
        * If any field is missing in the BOQ data, mark it as "" empty string.
        * Ensure every product is captured; be exhaustive.
        * When cells are merged in the BOQ, propagate values to all related rows until a new value appears.
        * Prioritize relevant Specifications over default names; capture specifics.
        * Avoid picking serial numbers or indices as the quantity.
        * Ensure only one product in the JSON and remove the duplicate entries.
        * Validate with unit types to further filter out incorrect extractions.
        * if given product present in product list or not, if present then rename the product name to match exactly the product name from the database. Prioritize exact matches, then use your intelligence matching with a high similarity threshold.  Look for similar patterns as the examples, such as pluralization differences, abbreviations (e.g., GI), and slight word order variations. product name present in databse might be change for example input product name is "xyz" and it may also be present in our database as "X YZ" you have to be extra smart. be like somone how have years of experiance working in heavy industry and have a good knowledge of product names and use your own intelegency as well.
        
        
        Sample Response:
        { "productList": [
          { "product_name": "Product1 from DB", "size": "size1", "specifications": "spec1", "quantity": 1, "unit": "unit1"},
          { "product_name": "Unknown Product", "size": "size2", "specifications": "spec2", "quantity": 2, "unit": "unit2"}
        ]
        }
        
        Here is the BOQ data:
        ${boqData}
        
        Products present in my database:
        ${uniqueProductList}
        `;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
        {
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      if (
        !response.data ||
        !response.data.candidates ||
        response.data.candidates.length === 0
      ) {
        return { error: 'Error processing BOQ with AI' };
      }

      const aiResponseText = response.data.candidates[0].content.parts[0].text;

      const jsonString = aiResponseText.includes('```json')
        ? aiResponseText
            .substring(
              aiResponseText.indexOf('```json') + 7,
              aiResponseText.lastIndexOf('```')
            )
            .trim()
        : aiResponseText.trim();

      // Convert to object
      const boqDataJson = JSON.parse(jsonString);
      return boqDataJson;
    } catch (error) {
      logError(error);
      return { error: 'Error processing BOQ with AI' };
    }
  },

  processBoqAndDownload: async (file) => {
    try {
      console.log("file ", file);
  
      if (!file || !file.location) {
        return { error: 'File is required' };
      }
  
      // Step 1: Download file from S3
      const fileResponse = await axios.get(file.location, {
        responseType: 'arraybuffer',
      });
  
      const buffer = Buffer.from(fileResponse.data);
  
      // Step 2: Create form-data and append file
      const formData = new FormData();
      formData.append('file', buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
  
      // Step 3: Make API call to process-boq
      const response = await axios.post(
        'https://test.letsworkwise.com/process-boq',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
        }
      );
  
      console.log("Processed BOQ response:", response.data);
      return response.data;
  
    } catch (error) {
      logError(error);
      return { error: 'Error processing BOQ with AI' };
    }
  }
};

export default generativeAI;
