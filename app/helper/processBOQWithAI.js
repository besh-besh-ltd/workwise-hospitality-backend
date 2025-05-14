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
    try {
      let buffer;
      if (file.location) {
        const s3Url = new URL(file.location);
        const bucket = s3Url.hostname.split('.')[0];
        const key = decodeURIComponent(s3Url.pathname).slice(1);
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const result = await s3Client.send(command);
        const webStream = Readable.toWeb(result.Body);
        const response = new Response(webStream);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      } else if (file.path) {
        buffer = fs.readFileSync(file.path);
      } else if (file.buffer) {
        buffer = file.buffer;
      } else {
        throw new Error('Invalid file format or location');
      }

      const fileExt = path.extname(file.originalname || file.filename).toLowerCase();
      
      if (fileExt === '.pdf') {
        try {
          const pdfText = await pdfParser.extractText(buffer);
          const cleanedText = pdfParser.cleanText(pdfText);

          const apiKey = process.env.GOOGLE_AI_API_KEY;
          if (!apiKey) {
            throw new Error('Google AI API Key is not configured');
          }

          const genAI = new GoogleGenerativeAI(apiKey);
          const modelName = 'gemini-1.5-flash'; // Reverted for stability
          const model = genAI.getGenerativeModel({ model: modelName });

          let prompt;
          // Changes by Agnij 2025-05-14 [Enhanced AI prompt for comprehensive extraction]
            prompt = `
            You are a specialized engineering AI expert tasked with extracting comprehensive technical and commercial information from engineering documents.
              
              TARGET PRODUCT: "${productName}"
              
            # DOCUMENT ANALYSIS TASK:
            Extract ALL technical specifications, commercial terms, quality standards, inspection requirements, notes, and conditions from the document.
            Focus specifically on information related to "${productName}" and similar products.
            
            # EXTRACTION GUIDELINES:
            1. PRESERVE ORIGINAL SENTENCES: Maintain the original sentence structure and phrasing. 
                Do not split natural sentences into parameter/value pairs if they're already written as complete statements.
            2. COMPREHENSIVE EXTRACTION: Extract ALL information - nothing should be missed.
            3. STRUCTURED OUTPUT: Group information into appropriate categories.
            4. MAINTAIN RELATIONSHIPS: Preserve relationships between parameters and values.
            5. TABLE EXTRACTION: Reconstruct tables where applicable.
            6. UNITS: Always include measurement units where available.
            
            # EXTRACTION CATEGORIES:
            - technicalSpecifications: All technical parameters, specifications, dimensions, materials, etc.
                For complete sentence specifications (e.g., "Mounting brackets shall be carbon steel"), keep these as full sentences in a "text" field.
            - commercialRequirements: Pricing, payment terms, delivery requirements, etc.
            - standards: Applicable codes, standards, certifications, compliances
            - inspectionRequirements: Testing, inspection, quality control requirements
            - notes: Important notes, warnings, exclusions, clarifications
            - tables: Any tabular data in the document
            - attachments: References to required attachments or documents
            
            # OUTPUT FORMAT:
            Return a JSON object with this structure:
            {
              "technicalSpecifications": [
                {"parameter": "param name", "value": "param value", "unit": "unit if any"},
                {"text": "complete sentence specification like 'Mounting brackets shall be carbon steel'"}
              ],
              "commercialRequirements": [{"parameter": "param name", "value": "param value"}],
              "standards": [{"standard": "standard name", "description": "description if any"}],
              "inspectionRequirements": [{"requirement": "requirement name", "description": "description if any"}],
              "notes": [{"note": "note text"}],
              "tables": [{"title": "table title", "headers": ["col1", "col2"], "rows": [["val1", "val2"], ["val3", "val4"]]}],
              "attachments": [{"name": "attachment name", "description": "description if any"}]
            }
            
            # STRICT RULE:
            ONLY respond with valid JSON in the exact format specified above, enclosed in triple backticks.
            Do not include any explanations or other text outside the JSON.
            
            Document text:
              ${cleanedText}
            `;

          const resultFromAI = await model.generateContent(prompt);
          const normalizedProduct = (productName || '').toLowerCase().trim();
          const normalizedText = cleanedText.toLowerCase();
          
          // Perform extremely strict product matching
          const performProductMatch = () => {
            // Skip matching if no product name provided
            if (!productName || normalizedProduct.length < 2) {
              return true; // Default to true when no product name provided
            }
            // Count exact matches of the product name (must be at least 2)
            const exactMatches = (normalizedText.match(new RegExp(`\\b${normalizedProduct}\\b`, 'gi')) || []).length;
            if (exactMatches >= 2) {
              return true;
            }
            // Additional check for product names with spaces or special characters
            // Split the product name and check if ALL significant terms appear multiple times
            const productTerms = normalizedProduct.split(/\s+/).filter(term => term.length > 3);
            if (productTerms.length >= 2) {
              const allTermsPresent = productTerms.every(term => {
                const termMatches = (normalizedText.match(new RegExp(`\\b${term}\\b`, 'gi')) || []).length;
                return termMatches >= 2;
              });
              if (allTermsPresent) {
                return true;
              }
            }
            return false;
          };
          const isProductMatch = performProductMatch();
          if (!isProductMatch) {
            return {
              status: 0,
              message: `No relevant information detected for ${productName}`,
              structuredData: null,
              clauses: []
            };
          }

          // Changes by Agnij May 13, 2025 [Improved extraction of AI response]
          const textFromAI = resultFromAI.response ? resultFromAI.response.text() : 
                         (typeof resultFromAI.text === 'function' ? resultFromAI.text() : 
                         (resultFromAI.text || JSON.stringify(resultFromAI)));
          
          
          const jsonMatch = textFromAI.match(/```json\n([\s\S]*?)\n```/) || 
                          textFromAI.match(/```\n([\s\S]*?)\n```/) || 
                          textFromAI.match(/{[\s\S]*?}/);
                          
          if (jsonMatch) {
            try {
              const jsonStr = jsonMatch[1] || jsonMatch[0];
              const extractedData = JSON.parse(jsonStr);
              
              let flattenedClauses = [];
              const aiData = extractedData;
              // Technical Specifications
              (aiData.technicalSpecifications || []).forEach(item => {
                if (typeof item === 'string') flattenedClauses.push(item);
                else if (item && item.text) flattenedClauses.push(item.text);
                else if (item && item.parameter && item.value) flattenedClauses.push(`${item.parameter}: ${item.value}${item.unit ? ' ' + item.unit : ''}`);
                else if (item && item.parameter) flattenedClauses.push(`${item.parameter}: ${item.value || 'N/A'}${item.unit ? ' ' + item.unit : ''}`);
                else if (item && typeof item === 'object' && Object.keys(item).length > 0) flattenedClauses.push(JSON.stringify(item));
              });

              // Commercial Requirements
              (aiData.commercialRequirements || []).forEach(item => {
                if (typeof item === 'string') flattenedClauses.push(item);
                else if (item && item.parameter && item.value) flattenedClauses.push(`${item.parameter}: ${item.value}`);
                else if (item && item.parameter) flattenedClauses.push(`${item.parameter}: ${item.value || 'N/A'}`);
                else if (item && typeof item === 'object' && Object.keys(item).length > 0) flattenedClauses.push(JSON.stringify(item));
              });

              // Standards
              (aiData.standards || []).forEach(item => {
                if (typeof item === 'string') flattenedClauses.push(item);
                else if (item && item.standard) flattenedClauses.push(`${item.standard}${item.description ? ' - ' + item.description : ''}`);
                else if (item && item.name) flattenedClauses.push(`${item.name}${item.description ? ' - ' + item.description : ''}`);
                else if (item && typeof item === 'object' && Object.keys(item).length > 0) flattenedClauses.push(JSON.stringify(item));
              });

              // Inspection Requirements
              (aiData.inspectionRequirements || []).forEach(item => {
                if (typeof item === 'string') flattenedClauses.push(item);
                else if (item && item.requirement) flattenedClauses.push(`${item.requirement}${item.description ? ' - ' + item.description : ''}`);
                else if (item && typeof item === 'object' && Object.keys(item).length > 0) flattenedClauses.push(JSON.stringify(item));
              });

              // Notes
              (aiData.notes || []).forEach(item => {
                if (typeof item === 'string') flattenedClauses.push(item);
                else if (item && item.note) flattenedClauses.push(item.note);
                else if (item && typeof item === 'object' && Object.keys(item).length > 0) flattenedClauses.push(JSON.stringify(item));
              });

              // Tables
              (aiData.tables || []).forEach((table, index) => {
                if (table && typeof table === 'object') {
                  let tableText = table.title ? `${table.title}\n\n` : `Table ${index + 1}\n`;
                  if (table.headers && Array.isArray(table.headers) && table.headers.length > 0) {
                    tableText += table.headers.join(' | ') + '\n';
                    tableText += table.headers.map(() => '---').join(' | ') + '\n';
                  }
                  if (table.rows && Array.isArray(table.rows)) {
                    table.rows.forEach(row => {
                      if (Array.isArray(row)) tableText += row.join(' | ') + '\n';
                    });
                  }
                  // Add tableText to flattenedClauses only if it contains more than just the initial title
                  const initialTitleOnly = table.title ? `${table.title}\n\n` : `Table ${index + 1}\n`;
                  if (tableText.trim() !== initialTitleOnly.trim() && tableText.trim() !== '') {
                      flattenedClauses.push(tableText.trim());
                  }
                } else if (typeof table === 'string') {
                  flattenedClauses.push(table);
                }
              });

              // Attachments
              (aiData.attachments || []).forEach(item => {
                if (typeof item === 'string') flattenedClauses.push(item);
                else if (item && item.name) flattenedClauses.push(`Attachment: ${item.name}${item.description ? ' - ' + item.description : ''}`);
                else if (item && typeof item === 'object' && Object.keys(item).length > 0) flattenedClauses.push(JSON.stringify(item));
              });
              
              // Remove empty or whitespace-only strings and ensure uniqueness
              flattenedClauses = [...new Set(flattenedClauses.map(c => c.trim()).filter(c => c !== ""))];
                
              return {
                status: 1,
                message: `Comprehensive information extracted successfully for ${productName}`,
                structuredData: { ...extractedData },
                clauses: flattenedClauses
              };
            } catch (parseError) {
              return { status: 0, message: 'Failed to parse structured data from AI', error: parseError.message, clauses: [] };
            }
          } else {

            // Better line extraction that preserves more structure
            const lines = textFromAI.split('\n').filter(line => line.trim().length > 0);
            
            // More comprehensive filtering for potential clauses
            const potentialClauses = lines.filter(line => {
              return line.length > 20 && 
              !line.includes('```') &&
              !line.startsWith('Here') &&
                     !line.startsWith('I will') &&
                     !line.startsWith('As an AI') &&
                     !line.startsWith('Based on');
            });
            
            
            // Create a consistent structure even in fallback mode
            const fallbackResponse = {
              status: 1,
              message: productName 
                ? `Information extracted (fallback) for ${productName}`
                : 'Information extracted (fallback)',
              structuredData: {
                technicalSpecifications: [],
                clauses: potentialClauses.map((text, idx) => ({ id: `F${idx+1}`, text })), // Add IDs to fallback clauses
                standards: [],
                notes: []
              },
              clauses: potentialClauses
            };
            
            return fallbackResponse;
          }
        } catch (pdfProcessingError) {
          const errorMessage = pdfProcessingError.message || pdfProcessingError.toString();
          return { status: 0, message: 'Error processing PDF with AI', error: errorMessage, clauses: [] };
        }
      } else {
        throw new Error('Unsupported file format. Please upload PDF files only.');
      }
    } catch (mainError) {
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
  
      return response.data;
  
    } catch (error) {
      logError(error);
      return { error: 'Error processing BOQ with AI' };
    }
  }
};

export default generativeAI;