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
import * as xlsx from 'xlsx'; // ✅ Added this line to fix the error

const PDFParser = (await import('pdf2json')).PDFParser || (await import('pdf2json')).default;


function extractTextFromPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on("pdfParser_dataError", err => reject(err.parserError));
    pdfParser.on("pdfParser_dataReady", pdfData => {
      const pages = pdfData?.Pages || pdfData?.formImage?.Pages;
      if (!pages) return reject(new Error("Unable to extract PDF pages"));

      let text = '';
      pages.forEach(page => {
        page.Texts.forEach(t => {
          const line = t.R.map(r => decodeURIComponent(r.T)).join('');
          text += line + ' ';
        });
        text += '\n';
      });

      resolve(text.trim());
    });

    pdfParser.parseBuffer(buffer);
  });
}


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
        buffer = Buffer.from(await result.Body.transformToByteArray());
      } else if (file.path) {
        buffer = fs.readFileSync(file.path);
      } else if (file.buffer) {
        buffer = file.buffer;
      } else {
        throw new Error('Invalid file format or location');
      }

      const fileExt = path.extname(file.originalname || file.filename).toLowerCase();
      if (fileExt !== '.pdf') throw new Error('Only PDF files are supported');

      // ✅ extract text using pdf2json
      const pdfText = await extractTextFromPDF(buffer);
      if (!pdfText || pdfText.trim().length < 50) {
        return { status: 0, message: 'Extracted text is too short or empty.' };
      }

      const apiKey = process.env.GOOGLE_AI_API_KEY;
      if (!apiKey) throw new Error('Google AI API Key is not configured');

      const prompt = `
You are a specialized engineering AI expert tasked with extracting comprehensive technical and commercial information from engineering documents.

TARGET PRODUCT: "${productName}"

# DOCUMENT ANALYSIS TASK:
xtract ALL technical specifications, commercial terms, quality standards, inspection requirements, notes, and conditions from the document.
Focus specifically on information related to "${productName}" and similar products.

# OUTPUT FORMAT:
\`\`\`json
{
  "technicalSpecifications": [{"parameter": "param", "value": "value", "unit": "unit"}, {"text": "sentence"}],
  "commercialRequirements": [{"parameter": "name", "value": "value"}],
  "standards": [{"standard": "name", "description": "desc"}],
  "inspectionRequirements": [{"requirement": "req", "description": "desc"}],
  "notes": [{"note": "text"}],
  "tables": [{"title": "title", "headers": ["h1", "h2"], "rows": [["v1","v2"]]}],
  "attachments": [{"name": "doc name", "description": "desc"}]
}
\`\`\`

ONLY return the JSON inside triple backticks. No extra commentary.

Document text:
${pdfText}
`;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }]
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const textFromAI = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!textFromAI) throw new Error('Empty response from Gemini API');

      const jsonMatch = textFromAI.match(/```json\n([\s\S]*?)\n```/) ||
                        textFromAI.match(/```\n([\s\S]*?)\n```/) ||
                        textFromAI.match(/{[\s\S]*?}/);

      if (!jsonMatch) {
        return { status: 0, message: 'Structured JSON not found in AI response', raw: textFromAI };
      }

      const structured = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      return {
        status: 1,
        message: `Information extracted successfully for ${productName}`,
        structuredData: structured,
        clauses: Object.values(structured).flat()
      };
    } catch (err) {
      logError(err);
      return { status: 0, message: err.message, clauses: [] };
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