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
        console.error('[processBOQWithAI.js] extractClauses: Invalid file format or location.');
        throw new Error('Invalid file format or location');
      }

      const fileExt = path.extname(file.originalname || file.filename).toLowerCase();
      
      if (fileExt === '.pdf') {
        try {
          const pdfText = await pdfParser.extractText(buffer);
          const cleanedText = pdfParser.cleanText(pdfText);

          const apiKey = process.env.GOOGLE_AI_API_KEY;
          if (!apiKey) {
            console.error('[processBOQWithAI.js] extractClauses: Google AI API Key is not configured.');
            throw new Error('Google AI API Key is not configured');
          }

          const genAI = new GoogleGenerativeAI(apiKey);
          const modelName = 'gemini-1.5-flash-latest'; // Reverted for stability
          const model = genAI.getGenerativeModel({ model: modelName });

          // Changes by Agnij 2024-05-14 [Strict product matching: inject product list into AI prompt]
          // Fetch all approved product names for strict AI matching
          const approvedProducts = await productModel.approvedProductList();
          const approvedProductNames = approvedProducts.map(p => p.name);

          let prompt;
          if (productName) {
            prompt = `
              You are an AI expert trained to extract detailed technical specifications, clauses, and regulatory information from technical datasheets for a specific product.
              
              TARGET PRODUCT: "${productName}"
              
              APPROVED PRODUCT LIST (for strict matching):
              ${JSON.stringify(approvedProductNames)}
              
              **IMPORTANT FIRST STEP:** Before extracting any information, you MUST check if the document is contextually relevant to the TARGET PRODUCT: "${productName}" AND if the product described in the document matches (even with fuzzy logic, abbreviations, or pluralization) ANY product in the APPROVED PRODUCT LIST above.
              - Contextual relevance means the document is primarily about the product or a very closely related concept.
              - For example, if the TARGET PRODUCT is 'flow meter', a document about 'flow gauge' or 'flow transmitter' IS contextually relevant.
              - However, if the TARGET PRODUCT is 'flow meter', a document primarily about 'flanges', 'pipes', or 'valves' IS NOT contextually relevant.
              - You must use the APPROVED PRODUCT LIST to decide if the product matches. If there is no match (even with fuzzy/abbreviation/pluralization logic), DO NOT EXTRACT.
              
              **IF THE DOCUMENT IS NOT CONTEXTUALLY RELEVANT OR DOES NOT MATCH ANY PRODUCT IN THE APPROVED PRODUCT LIST, YOU MUST RETURN AN EMPTY "clauses" array in the JSON output like this: { "clauses": [] }. Do not proceed with extraction.**
              
              **IF AND ONLY IF the document IS contextually relevant AND matches a product in the APPROVED PRODUCT LIST**, your task is to extract ALL information in its ORIGINAL STRUCTURE:
              
              1. Extract the COMPLETE tables, forms, sections and maintain their EXACT structure and organization
              2. Preserve ALL information exactly as it appears in the document
              3. Capture ALL technical parameters, specifications, notes, and clauses verbatim
              
              **CRITICAL EXTRACTION INSTRUCTIONS:**
              
              FOR DOCUMENT STRUCTURE:
              - Maintain the EXACT hierarchical organization of the document
              - Preserve the relationship between sections, subsections and their content

              - Maintain the document's logical flow and order of information
              
              FOR TABLES AND DATASHEETS:
              - Extract information ROW-WISE, treating each row as a complete unit of information
              - GROUP related rows under their subheadings when available in the document
              - Maintain special characters, symbols, and formatting from technical tables
              - Keep ALL unit indicators (°C, ℃, mm, etc.) in their original format and position
              
              FOR TECHNICAL SPECIFICATIONS:
              - Capture ALL numerical values with their exact units precisely as they appear
              - Preserve ranges, tolerances, min/max values, and their relationships
              - Maintain ALL dimensions, materials specifications, and their formatting
              - Extract ALL operating parameters, performance data, and ratings exactly as shown
              
              FOR NOTES AND LEGAL CLAUSES:
              - Preserve ALL inspection requirements, compliance statements, and certification needs
              - Maintain ALL warranty information, liability statements, and conditions
              - Capture ALL special instructions, warnings, and cautions with their exact wording
              
              FOR FORMATTING:
              - Preserve indentation if needed to show the hierarchical relationship between elements
              - Maintain precise spacing between elements to preserve visual structure
              - Preserve ALL abbreviations, symbols, and technical notations exactly as shown
              
              **DATA STRUCTURE INSTRUCTIONS:**
              - Extract ENTIRE significant sections or tables as complete units
              - Process each table ROW-BY-ROW, maintaining row relationships
              - Group rows under their respective subheadings when present
              - For each major section/table, create a separate clause entry
              - Include section headers/titles with their content to maintain context
              - Keep rows belonging to the same table together in their logical sequence
              - NEVER SPLIT tables or logical sections across multiple clauses
              
              Return the data in a structured JSON format with the following categories:
              { 
                "technicalSpecifications": [
                  { "parameter": "parameter name", "value": "parameter value", "unit": "unit of measurement (if applicable)" }
                ],
                "clauses": [
                  { "id": "clause number/id (if available)", "text": "clause text" }
                ],
                "standards": [
                  { "name": "standard name", "description": "brief description (if available)" }
                ],
                "notes": [
                  "important note 1",
                  "important note 2"
                ]
              }
              
              IMPORTANT CLASSIFICATION INSTRUCTIONS:
              - Put measurement data, parameters, ratings, and material specs in "technicalSpecifications" 
              - Put numbered clauses, contractual information, and requirements in "clauses"
              - Put industry standards, certifications, and codes in "standards"
              - Put general notes, warnings, and procedural information in "notes"
              - If you're uncertain where an item belongs, put it in the most appropriate category
              - This array should be empty for any category with no relevant data
              - If the document is not contextually relevant or does not match any product in the APPROVED PRODUCT LIST, ALL arrays should be empty
              
              Here is the document content:
              ${cleanedText}
            `;
          } else {
            prompt = `
              You are an AI expert in extracting technical specifications, clauses, and regulatory information from technical datasheets and engineering documents.
              
              Your task is to extract ALL information with PERFECT PRESERVATION of the ORIGINAL DOCUMENT STRUCTURE:
              
              1. Extract the COMPLETE tables, forms, sections maintaining their EXACT format and organization
              2. Preserve PRECISE layout including columns, rows, section titles, spacing, and indentation
              3. Capture ALL technical parameters, specifications, notes, and clauses VERBATIM
              
              **CRITICAL EXTRACTION INSTRUCTIONS:**
              
              FOR DOCUMENT STRUCTURE:
              - Maintain the EXACT hierarchical organization of the document
              - Preserve the relationship between sections, subsections and their content
              - Keep document title, page numbers, and section identifiers in their original positions
              - Maintain the document's logical flow and order of information
              
              FOR TABLES AND DATASHEETS:
              - Extract information ROW-WISE, treating each row as a complete unit of information
              - GROUP related rows under their subheadings when available in the document
              - Preserve ALL row numbers, headers, labels and title structure intact
              - Maintain special characters, symbols, and formatting from technical tables
              - Keep ALL unit indicators (°C, ℃, mm, etc.) in their original format and position
              
              FOR TECHNICAL SPECIFICATIONS:
              - Capture ALL numerical values with their exact units precisely as they appear
              - Preserve ranges, tolerances, min/max values, and their relationships
              - Maintain ALL dimensions, materials specifications, and their formatting
              - Extract ALL operating parameters, performance data, and ratings exactly as shown
              
              FOR NOTES AND LEGAL CLAUSES:
              - Extract ALL numbered notes, requirements, and footnotes completely
              - Preserve ALL inspection requirements, compliance statements, and certification needs
              - Maintain ALL warranty information, liability statements, and conditions
              - Capture ALL special instructions, warnings, and cautions with their exact wording
              
              FOR FORMATTING:
              - Preserve indentation to show the hierarchical relationship between elements
              - Maintain precise spacing between elements to preserve visual structure
              - Preserve ALL abbreviations, symbols, and technical notations exactly as shown
              
              **DATA STRUCTURE INSTRUCTIONS:**
              - Extract ENTIRE significant sections or tables as complete units
              - Process each table ROW-BY-ROW, maintaining row relationships
              - Group rows under their respective subheadings when present
              - For each major section/table, create a separate clause entry
              - Include section headers/titles with their content to maintain context
              - Keep rows belonging to the same table together in their logical sequence
              - NEVER SPLIT tables or logical sections across multiple clauses
              
                            Return the data in a structured JSON format with the following categories:
              { 
                "technicalSpecifications": [
                  { "parameter": "parameter name", "value": "parameter value", "unit": "unit of measurement (if applicable)" }
                ],
                "clauses": [
                  { "id": "clause number/id (if available)", "text": "clause text" }
                ],
                "standards": [
                  { "name": "standard name", "description": "brief description (if available)" }
                ],
                "notes": [
                  "important note 1",
                  "important note 2"
                ]
              }
              
              IMPORTANT CLASSIFICATION INSTRUCTIONS:
              - Put measurement data, parameters, ratings, and material specs in "technicalSpecifications" 
              - Put numbered clauses, contractual information, and requirements in "clauses"
              - Put industry standards, certifications, and codes in "standards"
              - Put general notes, warnings, and procedural information in "notes"
              - If you're uncertain where an item belongs, put it in the most appropriate category
              - This array should be empty for any category with no relevant data
              
              Here is the document content:
              ${cleanedText}
            `;
          }

          const resultFromAI = await model.generateContent(prompt);
          // After AI extraction, check if the original PDF text contains a strong match for the productName
          const normalizedProduct = (productName || '').toLowerCase().replace(/s$/, '');
          const normalizedText = cleanedText.toLowerCase();
          // Simple plural/variant match: check for productName, productName+'s', and productName without trailing s
          const productRegex = new RegExp(`\\b${normalizedProduct}(s)?\\b`, 'i');
          if (!productRegex.test(normalizedText)) {
            console.warn(`[processBOQWithAI.js] Post-AI filter: No strong match for product '${productName}' in document. Returning empty result.`);
            return {
              status: 0,
              message: `No relevant information detected for product '${productName}' (post-AI filter)`,
              clauses: [],
              structuredData: { technicalSpecifications: [], clauses: [], standards: [], notes: [] }
            };
          }

          // Changes by Agnij May 13, 2025 [Improved extraction of AI response]
          const textFromAI = resultFromAI.response ? resultFromAI.response.text() : 
                         (typeof resultFromAI.text === 'function' ? resultFromAI.text() : 
                         (resultFromAI.text || JSON.stringify(resultFromAI)));

          console.log('[processBOQWithAI.js] extractClauses: Received response from AI, parsing JSON...');
          
          const jsonMatch = textFromAI.match(/```json\n([\s\S]*?)\n```/) || 
                          textFromAI.match(/```\n([\s\S]*?)\n```/) || 
                          textFromAI.match(/{[\s\S]*?}/);
                          
          if (jsonMatch) {
            try {
              const jsonStr = jsonMatch[1] || jsonMatch[0];
              console.log('[processBOQWithAI.js] extractClauses: Found JSON data, parsing...');
              const extractedData = JSON.parse(jsonStr);
              
              // Count items in each category for logging
              const techSpecCount = extractedData.technicalSpecifications?.length || 0;
              const clausesCount = extractedData.clauses?.length || 0;
              const standardsCount = extractedData.standards?.length || 0;
              const notesCount = extractedData.notes?.length || 0;
              
              console.log(`[processBOQWithAI.js] extractClauses: Parsed ${techSpecCount} tech specs, ${clausesCount} clauses, ${standardsCount} standards, ${notesCount} notes`);
              
              // Process each category for response
              const processedResponse = {
                status: 1,
                message: productName 
                  ? `Comprehensive information extracted successfully for ${productName}`
                  : 'Comprehensive information extracted successfully',
                structuredData: {
                  technicalSpecifications: extractedData.technicalSpecifications || [],
                  clauses: extractedData.clauses || [],
                  standards: extractedData.standards || [],
                  notes: extractedData.notes || []
                },
                // Legacy format support - flatten all text content for backward compatibility
                clauses: [
                  // Technical specifications as text
                  ...(extractedData.technicalSpecifications || []).map(spec => 
                    `${spec.parameter}: ${spec.value}${spec.unit ? ' ' + spec.unit : ''}`
                  ),
                  // Clauses as text
                  ...(extractedData.clauses || []).map(clause => 
                    clause.id ? `${clause.id}: ${clause.text}` : clause.text
                  ),
                  // Standards as text
                  ...(extractedData.standards || []).map(std => 
                    std.description ? `${std.name}: ${std.description}` : std.name
                  ),
                  // Notes as is
                  ...(extractedData.notes || [])
                ]
              };
              
              // Log the total number of flattened clauses
              console.log(`[processBOQWithAI.js] extractClauses: Total flattened clauses count: ${processedResponse.clauses.length}`);
              
              return processedResponse;
            } catch (parseError) {
              console.error('[processBOQWithAI.js] extractClauses: Error parsing JSON from Gemini response:', parseError.message, 'Raw JSON string attempt:', jsonMatch[1] || jsonMatch[0]);
              return { status: 0, message: 'Failed to parse structured data from AI', error: parseError.message, clauses: [] };
            }
          } else {
            // Changes by Agnij May 13, 2025 [Improved fallback extraction]
            console.warn('[processBOQWithAI.js] extractClauses: No JSON block found in AI response. Attempting manual line extraction.', `First 500 chars of AI response: ${textFromAI.substring(0,500)}`);
            
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
            
            console.log(`[processBOQWithAI.js] extractClauses: Fallback mode - extracted ${potentialClauses.length} potential clauses from ${lines.length} lines`);
            
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
            
            console.log(`[processBOQWithAI.js] extractClauses: Total fallback clauses count: ${fallbackResponse.clauses.length}`);
            return fallbackResponse;
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
