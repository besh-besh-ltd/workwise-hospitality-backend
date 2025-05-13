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
            // Changes by Agnij 2024-05-14 [Enhanced AI prompt for comprehensive extraction]
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
              
              // Changes by Agnij 2024-05-14 [Enhanced processing to better group related clauses]
              // Log all categories that were extracted
              const techSpecs = extractedData.technicalSpecifications || [];
              const clauses = extractedData.clauses || extractedData.commercialRequirements || [];
              const standards = extractedData.standards || [];
              const notes = extractedData.notes || [];
              const tables = extractedData.tables || [];
              const inspectionReqs = extractedData.inspectionRequirements || [];
              const attachments = extractedData.attachments || [];
              
              // Use the structured sections from the pdfParser if available
              const structuredSections = pdfParser._lastStructuredSections || [];

              // Changes by Agnij 2024-05-14 [Improved clause grouping based on content relationships]
              // Group related clauses together for better organization and display
              const groupClauses = (items, sectionName) => {
                const groupedItems = [];
                let currentGroup = null;
                
                // Group patterns - detect related items that should be grouped together
                const groupPatterns = {
                  'flow': /flow|rate|capacity/i,
                  'pressure': /pressure|psi|bar|kpa/i,
                  'temperature': /temperature|temp|°c|°f/i,
                  'material': /material|alloy|steel|metal/i,
                  'dimension': /dimension|size|diameter|width|height/i,
                  'electrical': /voltage|current|electrical|power/i,
                  'certification': /certification|standard|iso|astm|api/i,
                  'inspection': /inspection|test|quality|qc|qa/i,
                  'notes': /note|nb|remark/i,
                  'commercial': /commercial|price|cost|warranty|payment/i,
                  'abbreviation': /vta|tba|to be advised|vendor to advise/i
                };
                
                items.forEach(item => {
                  // Skip empty or invalid items
                  if (!item || (typeof item === 'object' && !Object.keys(item).length)) {
                    return;
                  }
                  
                  const itemText = typeof item === 'string' ? 
                    item : (item.clauseDescription || item.text || item.value || item.parameter || 
                           (item.parameter && item.value ? `${item.parameter}: ${item.value}` : JSON.stringify(item)));
                  
                  // Determine which group this item belongs to
                  let groupKey = null;
                  for (const [key, pattern] of Object.entries(groupPatterns)) {
                    if (pattern.test(itemText.toLowerCase())) {
                      groupKey = key;
                      break;
                    }
                  }
                  
                  // Special case for paired abbreviations: VTA/TBA
                  if (itemText.match(/^(VTA|TBA)[\s:.-]/i) || itemText.match(/\b(VENDOR TO ADVISE|TO BE ADVISED)\b/i)) {
                    groupKey = 'abbreviation';
                  }
                  
                  // Create a new group or add to existing group
                  if (!groupKey) {
                    // Individual item with no specific group
                    groupedItems.push({
                      title: null,
                      items: [item]
                    });
                  } else if (!currentGroup || currentGroup.key !== groupKey) {
                    // Start a new group
                    currentGroup = {
                      key: groupKey,
                      title: sectionName || titleCase(groupKey),
                      items: [item]
                    };
                    groupedItems.push(currentGroup);
                  } else {
                    // Add to current group
                    currentGroup.items.push(item);
                  }
                });
                
                return groupedItems;
              };
              
              // Helper to create title case
              const titleCase = (str) => {
                return str.replace(/\w\S*/g, (txt) => {
                  return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
                });
              };
              
              // Process and group different data types
              const groupedTechSpecs = groupClauses(techSpecs, 'Technical Specifications');
              const groupedStandards = groupClauses(standards, 'Standards & Certifications');
              const groupedNotes = groupClauses(notes, 'Notes & Remarks');
              const groupedInspection = groupClauses(inspectionReqs, 'Inspection Requirements');
              
              // Create more structured clause format
              let structuredClauses = [];
              
              // Process technical specifications with proper units
              if (groupedTechSpecs.length > 0) {
                groupedTechSpecs.forEach(group => {
                  const groupItems = group.items.map(spec => {
                    if (typeof spec === 'string') {
                      return spec;
                    }
                    
                    if (spec.text) {
                      // For complete sentences, use them directly
                      return spec.text;
                    }
                    
                    let clauseText = '';
                    if (spec.parameter) {
                      clauseText = `${spec.parameter}: ${spec.value || ''}`;
                      if (spec.unit) clauseText += ` ${spec.unit}`;
                    } else {
                      clauseText = JSON.stringify(spec);
                    }
                    return clauseText;
                  });
                  
                  structuredClauses.push({
                    clauseTitle: group.title,
                    clauseDescription: groupItems.join('\n')
                  });
                });
              }
              
              // Process standards with descriptions
              if (groupedStandards.length > 0) {
                groupedStandards.forEach(group => {
                  const standardItems = group.items.map(std => {
                    if (typeof std === 'string') {
                      return std;
                    }
                    
                    return `${std.standard || std.name || ''} ${std.description ? '- ' + std.description : ''}`;
                  });
                  
                  structuredClauses.push({
                    clauseTitle: group.title,
                    clauseDescription: standardItems.join('\n')
                  });
                });
              }
              
              // Process notes with proper formatting
              if (groupedNotes.length > 0) {
                groupedNotes.forEach(group => {
                  const noteItems = group.items.map((note, idx) => {
                    if (typeof note === 'string') {
                      return `Note ${idx + 1}: ${note}`;
                    }
                    
                    return `Note ${idx + 1}: ${note.note || JSON.stringify(note)}`;
                  });
                  
                  structuredClauses.push({
                    clauseTitle: group.title,
                    clauseDescription: noteItems.join('\n')
                  });
                });
              }
              
              // Process inspection requirements
              if (groupedInspection.length > 0) {
                groupedInspection.forEach(group => {
                  const inspectionItems = group.items.map(req => {
                    if (typeof req === 'string') {
                      return req;
                    }
                    
                    return `${req.requirement || ''} ${req.description ? '- ' + req.description : ''}`;
                  });
                  
                  structuredClauses.push({
                    clauseTitle: group.title,
                    clauseDescription: inspectionItems.join('\n')
                  });
                });
              }
              
              // Process tables with proper formatting
              if (tables.length > 0) {
                tables.forEach((table, index) => {
                  let tableText = '';
                  
                  // Add title if available
                  if (table.title) {
                    tableText += `${table.title}\n\n`;
                  }
                  
                  // Add headers
                  if (table.headers && Array.isArray(table.headers) && table.headers.length > 0) {
                    tableText += table.headers.join(' | ') + '\n';
                    tableText += table.headers.map(() => '---').join(' | ') + '\n';
                  }
                  
                  // Add rows
                  if (table.rows && Array.isArray(table.rows)) {
                    table.rows.forEach(row => {
                      if (Array.isArray(row)) {
                        tableText += row.join(' | ') + '\n';
                      }
                    });
                  }
                  
                  structuredClauses.push({
                    clauseTitle: `Table ${index + 1}`,
                    clauseDescription: tableText
                  });
                });
              }
              
              // Changes by Agnij 2024-05-14 [Special handling for flow data]
              // Ensure flow values are properly formatted from ranges to min/normal/max format
              const processFlowValues = (clauses) => {
                return clauses.map(clause => {
                  if (typeof clause === 'string') {
                    // Check if this is a flow range in the form "Flow (min / nor / max) 964-1060.4"
                    const flowRangeMatch = clause.match(/Flow\s*\(\s*min\s*\/\s*nor\s*\/\s*max\s*\)\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/i);
                    if (flowRangeMatch) {
                      const min = parseFloat(flowRangeMatch[1]) / 2; // Half of normal is min
                      const nor = parseFloat(flowRangeMatch[1]);
                      const max = parseFloat(flowRangeMatch[2]);
                      return `Flow (min / nor / max) ${min} / ${nor} / ${max}`;
                    }
                    return clause;
                  } else if (clause.clauseTitle && clause.clauseDescription) {
                    // Process flow descriptions within the clause
                    if (clause.clauseTitle.match(/flow|rate|capacity/i)) {
                      const flowRangeMatch = clause.clauseDescription.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/);
                      if (flowRangeMatch) {
                        const min = parseFloat(flowRangeMatch[1]) / 2; // Calculate min as half of normal
                        const nor = parseFloat(flowRangeMatch[1]);
                        const max = parseFloat(flowRangeMatch[2]);
                        clause.clauseDescription = clause.clauseDescription.replace(
                          flowRangeMatch[0],
                          `${min} / ${nor} / ${max}`
                        );
                      }
                    }
                    return clause;
                  }
                  return clause;
                });
              };
              
              // Process flow values in structured clauses
              structuredClauses = processFlowValues(structuredClauses);
              
              // Merge with normal clauses list for backward compatibility
              let flattenedClauses = [];
              
              // Add structured clauses
              structuredClauses.forEach(clause => {
                if (typeof clause === 'string') {
                  flattenedClauses.push(clause);
                } else {
                  if (clause.clauseTitle) {
                    flattenedClauses.push(clause.clauseTitle);
                  }
                  if (clause.clauseDescription) {
                    flattenedClauses.push(clause.clauseDescription);
                  }
                }
              });
              
              // Add any clauses that weren't processed
              if (clauses.length > 0) {
                clauses.forEach(clause => {
                  const clauseText = typeof clause === 'string' ? 
                    clause : (clause.text || clause.value || JSON.stringify(clause));
                  
                  if (!flattenedClauses.includes(clauseText)) {
                    flattenedClauses.push(clauseText);
                  }
                });
              }
                
                
              return {
                status: 1,
                message: `Comprehensive information extracted successfully for ${productName}`,
                structuredData: {
                  ...extractedData,
                  groupedClauses: structuredClauses
                },
                clauses: flattenedClauses
              };
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
