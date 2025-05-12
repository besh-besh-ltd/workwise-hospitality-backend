import axios from 'axios';
import xlsx from 'xlsx';
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
    try {
      // Handle file from S3 or local upload
      let buffer;
      if (file.location) {
        // File is in S3
        const s3Url = new URL(file.location);
        const bucket = s3Url.hostname.split('.')[0];
        const key = decodeURIComponent(s3Url.pathname).slice(1); // remove leading '/'
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        const result = await s3Client.send(command);
        const webStream = Readable.toWeb(result.Body);
        const response = new Response(webStream);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      } else if (file.path) {
        // File is locally uploaded
        buffer = fs.readFileSync(file.path);
      } else if (file.buffer) {
        // File is already a buffer
        buffer = file.buffer;
      } else {
        throw new Error('Invalid file format or location');
      }

      // Determine file type and process accordingly
      const fileExt = path.extname(file.originalname || file.filename).toLowerCase();
      
      if (fileExt === '.pdf') {
        // Changes by Agnij June 22, 2026 [Integrated parsePdf and processClausesWithAI inside extractClauses]
        // Parse and process PDF file with AI
        try {
          // Parse the PDF using the integrated parsePdf functionality
          const pdfText = await pdfParser.extractText(buffer);
          const cleanedText = pdfParser.cleanText(pdfText);

          // Initialize the Google Generative AI client
          const apiKey = process.env.GOOGLE_AI_API_KEY;
          if (!apiKey) {
            throw new Error('Google AI API Key is not configured');
          }

          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

          // Create the prompt for clause extraction - focusing specifically on clauses for the given product
          let prompt;
          
          if (productName) {
            // Changes by Agnij June 22, 2026 [Enhanced prompt for better technical data extraction]
            prompt = `
              You are an AI trained to extract comprehensive technical information from documents for a specific product.
              
              TARGET PRODUCT: "${productName}"
              
              Extract ALL of the following information related to "${productName}" from the document:
              1. Technical evaluation clauses and requirements
              2. Technical specifications (including ALL dimensions, materials, performance parameters)
              3. Technical Data Sheet (TDS) or Instrument Data Sheet (IDS) information
              4. Compliance criteria and standards (ISO, ASTM, etc.)
              5. Inspection protocols and quality control requirements
              6. Testing methodologies and parameters
              7. Installation procedures and requirements
              8. Maintenance guidelines
              9. Safety requirements and warnings
              10. Operational parameters
              11. Warranty conditions and exclusions
              12. Other contractual obligations related to this specific product
              
              CRITICALLY IMPORTANT INSTRUCTIONS:
              - Maintain the EXACT hierarchical structure and formatting of technical specifications
              - Preserve ALL numbered or bulleted lists exactly as they appear
              - Keep ALL tables, measurements and numerical values with their units intact
              - Include ALL conditional statements (if/then logic) in technical requirements
              - Capture specifications even if "${productName}" is not explicitly mentioned but context makes it clear
              - DO NOT rephrase or summarize specifications - use the EXACT ORIGINAL text
              - Capture specifications even if they span across different pages/sections
              - Pay special attention to footnotes and references related to specifications
              - Preserve cross-references between sections
              - Identify text that applies to ALL products vs. "${productName}" specifically
              
              Return the data in a JSON format with the following structure:
              { 
                "clauses": [
                  { "text": "complete original clause or specification text" }
                ]
              }
              
              Here is the document content:
              ${cleanedText}
            `;
          } else {
            // Enhanced general prompt for when no product name is provided
            prompt = `
              You are an AI trained to extract comprehensive technical and contractual information from documents.
              
              Extract ALL of the following information from the document:
              1. Legal contract clauses and technical requirements
              2. Technical specifications (dimensions, materials, performance parameters)
              3. Technical Data Sheet (TDS) or Instrument Data Sheet (IDS) information
              4. Contractual terms and conditions
              5. Compliance criteria and standards
              6. Testing requirements and acceptance criteria
              7. Installation, operation, and maintenance specifications
              8. Warranty and liability clauses
              9. Safety requirements and warnings
              
              CRITICALLY IMPORTANT INSTRUCTIONS:
              - Maintain the EXACT hierarchical structure of all content
              - Preserve ALL numbered or bulleted lists exactly as they appear
              - Keep ALL tables, measurements and numerical values with their units intact
              - Include ALL conditional statements and logical relationships
              - DO NOT rephrase or summarize - use the EXACT ORIGINAL text
              - Preserve section headings and their relationships to content
              - Keep the relationships between specifications and their products/components clear
              - Maintain all cross-references between clauses
              
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

          // Call the Gemini AI
          const result = await model.generateContent(prompt);
          
          // Properly extract text from the response object
          const text = result.response ? result.response.text() : 
                      (typeof result.text === 'function' ? result.text() : 
                      (result.text || JSON.stringify(result)));
          
          // Extract JSON from the response
          const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || 
                          text.match(/```\n([\s\S]*?)\n```/) || 
                          text.match(/{[\s\S]*?}/);
                          
          if (jsonMatch) {
            try {
              // Parse the extracted JSON
              const jsonStr = jsonMatch[1] || jsonMatch[0];
              const extractedData = JSON.parse(jsonStr);
              
              // Return the clauses
              return {
                status: 1,
                message: productName 
                  ? `Comprehensive technical data extracted successfully for ${productName}`
                  : 'Technical data and clauses extracted successfully',
                clauses: extractedData.clauses.map(clause => clause.text)
              };
            } catch (error) {
              console.error('Error parsing JSON from Gemini response:', error.message);
              return { 
                status: 0, 
                message: 'Failed to parse structured data', 
                error: error.message,
                clauses: [] 
              };
            }
          } else {
            // If no JSON found, try to extract clause-like text manually
            const lines = text.split('\n').filter(line => line.trim().length > 0);
            const potentialClauses = lines.filter(line => 
              line.length > 20 && 
              !line.includes('```') &&
              !line.startsWith('Here') &&
              !line.startsWith('I will')
            );
            
            return {
              status: 1,
              message: productName 
                ? `Technical data extracted from text response for ${productName}`
                : 'Technical data extracted from text response',
              clauses: potentialClauses
            };
          }
        } catch (error) {
          // Handle both Error objects and plain objects from parsePdf
          const errorMessage = error.message || error.toString();
          console.error('Error processing PDF with AI:', errorMessage);
          
          return { 
            status: 0, 
            message: 'Error processing file with AI', 
            error: errorMessage,
            clauses: [] 
          };
        }
      } else if (['.xlsx', '.xls', '.csv'].includes(fileExt)) {
        // Process Excel file
        const workbook = xlsx.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(sheet);
        
        // Changes by Agnij June 22, 2026 [Integrated Excel processing directly into extractClauses]
        // Extract clauses from Excel data
        try {
          if (!jsonData || jsonData.length === 0) {
            return {
              status: 0,
              message: 'No clauses found in the file',
              clauses: []
            };
          }

          // First, determine which column contains the clauses
          const firstRow = jsonData[0];
          const clauseColumn = Object.keys(firstRow).find(key => 
            key.toLowerCase().includes('clause') || 
            key.toLowerCase().includes('list') || 
            key.toLowerCase().includes('text')
          ) || Object.keys(firstRow)[0]; // Default to first column if no suitable column found

          // If product name is provided, filter entries that match the product
          let clauses;
          
          if (productName) {
            // If product name is provided, filter entries that match the product
            const productColumn = Object.keys(firstRow).find(key => 
              key.toLowerCase().includes('product') || 
              key.toLowerCase().includes('item') || 
              key.toLowerCase().includes('name')
            );
            
            if (productColumn) {
              // If there's a product column, filter by product name
              clauses = jsonData
                .filter(row => {
                  const rowProductName = row[productColumn];
                  return rowProductName && 
                        typeof rowProductName === 'string' && 
                        rowProductName.toLowerCase().includes(productName.toLowerCase());
                })
                .map(row => {
                  const clauseText = row[clauseColumn];
                  return clauseText && typeof clauseText === 'string' ? clauseText.trim() : null;
                })
                .filter(Boolean); // Remove null or empty values
            } else {
              // If no product column, use all entries but look for product name in text
              clauses = jsonData
                .map(row => {
                  const clauseText = row[clauseColumn];
                  return clauseText && 
                         typeof clauseText === 'string' && 
                         clauseText.toLowerCase().includes(productName.toLowerCase()) ? 
                         clauseText.trim() : null;
                })
                .filter(Boolean); // Remove null or empty values
            }
          } else {
            // Without product name, extract all clauses
            clauses = jsonData
              .map(row => {
                const clauseText = row[clauseColumn];
                return clauseText && typeof clauseText === 'string' ? clauseText.trim() : null;
              })
              .filter(Boolean); // Remove null or empty values
          }

          return {
            status: 1,
            message: productName 
              ? `Clauses extracted successfully for ${productName}`
              : 'Clauses extracted successfully',
            clauses: clauses
          };
        } catch (error) {
          logError(error);
          return { 
            status: 0, 
            message: 'Error processing Excel file', 
            error: error.message,
            clauses: [] 
          };
        }
      } else {
        throw new Error('Unsupported file format. Please upload PDF, Excel, or CSV files.');
      }
    } catch (error) {
      logError(error);
      return { 
        status: 0, 
        message: 'Error processing file with AI', 
        error: error.message,
        clauses: [] 
      };
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
