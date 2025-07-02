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

  // mukul 18-05-2025, removed gemini and implemented AI
  // mukul 21-05-2025, remove ai api call as it will take lot's time to execute, leaving this function for now as it may be usefull if we need to do further processing of json or other data   if like to donload just move "downloadResponse" in rfqController
  processBOQWithAI: async (aiProcessedBoqJson) => {
    try {


     // download the file from ai server
      const secureUrl = aiProcessedBoqJson.startsWith('http://test')
        ? aiProcessedBoqJson.replace('http://', 'https://')
        : aiProcessedBoqJson;
      

      const downloadResponse = await axios.get(secureUrl);

      return downloadResponse?.data || [] ;
    } catch (error) {
      logError(error);
      return { error: 'Error processing BOQ with AI' };
    }
  },

};

export default generativeAI;