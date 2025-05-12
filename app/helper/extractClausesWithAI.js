import xlsx from 'xlsx';
import { logError } from './common.js';
import s3Client from '../config/s3config.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import pkg from 'nodemailer/lib/xoauth2/index.js';
const { Readable } = pkg;
import fs from 'fs';
import path from 'path';
import pdfParser from './pdfParser.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Changes by Agnij May 11, 2025 [Updated AI extraction for clauses]
const extractClausesWithAI = {
  // Extract clauses from uploaded file using AI
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
        // Process PDF file with AI
        return await processWithAI(buffer, productName);
      } else if (['.xlsx', '.xls', '.csv'].includes(fileExt)) {
        // Process Excel file
        const workbook = xlsx.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(sheet);
        
        // Extract clauses from Excel data
        return extractClausesFromExcel(jsonData, productName);
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
  }
};

// Parse PDF content using our custom parser
// Changes by Agnij May 11, 2025 [Updated to handle errors properly]
async function parsePdf(buffer) {
  try {
    const text = await pdfParser.extractText(buffer);
    return text;
  } catch (error) {
    // Create a simpler error object without stack properties
    console.error('PDF parsing failed:', error.message);
    // Use a plain object instead of Error to avoid stack issues
    throw { message: `Failed to parse PDF file: ${error.message}` };
  }
}

// Clean PDF text using our custom parser
// Changes by Agnij May 11, 2025 [Updated to use custom parser]
function cleanPdfText(text) {
  return pdfParser.cleanText(text);
}

// Process file with AI using the exp_ai integration
async function processWithAI(buffer, productName) {
  try {
    // Parse the PDF
    const pdfText = await parsePdf(buffer);
    const cleanedText = cleanPdfText(pdfText);

    // Initialize the Google Generative AI client
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('Google AI API Key is not configured');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Changes by Agnij June 22, 2026 [Enhanced AI prompt to filter by product name]
    // Create the prompt for clause extraction - focusing specifically on clauses for the given product
    let prompt;
    
    if (productName) {
      prompt = `
        You are an AI trained to extract relevant information from technical documents for a specific product.
        
        TARGET PRODUCT: "${productName}"
        
        Your task is to extract ONLY information related to "${productName}" from the document, including:
        1. Technical evaluation clauses
        2. Technical specifications and requirements
        3. Compliance criteria
        4. Inspection details
        5. Testing requirements
        6. Other contractual obligations related to this specific product
        
        IMPORTANT INSTRUCTIONS:
        - Focus ONLY on information related to "${productName}"
        - If the document contains information about multiple products, ONLY extract information for "${productName}"
        - Intelligently determine which sections or clauses refer to "${productName}" even if not explicitly labeled
        - Ignore information about other products
        - Use context clues to identify relevant information when the product name isn't explicitly mentioned
        - Maintain the original wording and technical accuracy
        
        Return the data in a JSON format with the following structure:
        { 
          "clauses": [
            { "text": "clause or specification text for ${productName}" }
          ]
        }
        
        Here is the document content:
        ${cleanedText}
      `;
    } else {
      // Fallback to the general prompt when no product name is provided
      prompt = `
        You are an AI trained to extract ONLY contract clauses from documents. 
        Your task is to identify and extract ONLY the clauses, not technical specifications or other content.
        
        Focus EXCLUSIVELY on:
        1. Legal contract clauses
        2. Contractual terms and conditions
        3. Obligations and requirements stated as clauses
        4. Technical specifications (like dimensions, materials)
        5. Product descriptions
        6. General notes that aren't contractual in nature for the product
        
        DO NOT include:
        1. Headers, footers, or metadata
        2. Other details not relevant to the product
        
        Return the data in a JSON format with the following structure:
        { 
          "clauses": [
            { "text": "clause text" }
          ]
        }
        
        Make sure to:
        1. Extract complete clauses with proper context
        2. Maintain the original wording
        3. Separate distinct clauses (don't combine different requirements)
        4. Remove duplicate clauses
        5. Ignore technical specifications and product details
        
        Here is the document content:
        ${cleanedText}
      `;
    }

    // Changes by Agnij May 12, 2025 [Fixed JSON extraction from Gemini API response]
    const result = await model.generateContent(prompt);
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
            ? `Clauses and specifications extracted successfully for ${productName}`
            : 'Clauses extracted successfully',
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
          ? `Clauses extracted from text response for ${productName}`
          : 'Clauses extracted from text response',
        clauses: potentialClauses
      };
    }
  } catch (error) {
    // Handle both Error objects and plain objects from parsePdf
    const errorMessage = error.message || error.toString();
    console.error('Error processing file with AI:', errorMessage);
    
    return { 
      status: 0, 
      message: 'Error processing file with AI', 
      error: errorMessage,
      clauses: [] 
    };
  }
}

// Extract clauses from Excel data
function extractClausesFromExcel(jsonData, productName) {
  try {
    if (!jsonData || jsonData.length === 0) {
      return {
        status: 0,
        message: 'No clauses found in the file',
        clauses: []
      };
    }

    // Extract clauses from the Excel data
    // First, determine which column contains the clauses
    const firstRow = jsonData[0];
    const clauseColumn = Object.keys(firstRow).find(key => 
      key.toLowerCase().includes('clause') || 
      key.toLowerCase().includes('list') || 
      key.toLowerCase().includes('text')
    ) || Object.keys(firstRow)[0]; // Default to first column if no suitable column found

    // Changes by Agnij June 22, 2026 [Added product name filtering for Excel files]
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
}

export default extractClausesWithAI; 