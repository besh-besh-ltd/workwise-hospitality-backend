// Changes by Agnij May 11, 2025 [Fixed CommonJS import]
import pkg from 'pdfjs-dist';
const { getDocument } = pkg;
import { logError } from './common.js';
import fs from 'fs';
import path from 'path';

// Set up worker source path for Node environment
// Changes by Agnij May 11, 2025 [Improved pdfjs worker configuration]
const pdfjsWorkerPath = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.js');
let pdfjsWorkerSource = null;

try {
  // Load worker source directly from filesystem
  if (fs.existsSync(pdfjsWorkerPath)) {
    pdfjsWorkerSource = pdfjsWorkerPath;
  }
} catch (error) {
  console.warn('Could not find PDF.js worker file:', error.message);
}

// Changes by Agnij May 11, 2025 [Safe error logging]
const safeLogError = (message) => {
  console.error('PDF Parser Error:', message);
};

// Changes by Agnij May 11, 2025 [Created robust custom PDF parser]
const pdfParser = {
  /**
   * Parse a PDF buffer and extract text content
   * @param {Buffer} buffer - PDF file as buffer
   * @returns {Promise<string>} - Extracted text from PDF
   */
  extractText: async (buffer) => {
    if (!buffer || buffer.length === 0) {
      safeLogError('Invalid or empty PDF buffer provided');
      throw new Error('Invalid or empty PDF buffer provided');
    }

    try {
      // Set up the pdfjsLib - no need to import again, use pkg
      const pdfjsLib = pkg;
      
      // Configure worker - use in-memory worker if needed
      if (pdfjsWorkerSource) {
        // Use the pre-loaded worker path
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSource;
      } else {
        // Disable worker to use main thread instead
        pdfjsLib.GlobalWorkerOptions.disableWorker = true;
      }
      
      // Changes by Agnij May 11, 2025 [Convert Buffer to Uint8Array]
      // Convert Buffer to Uint8Array - required by pdf.js
      const uint8Array = new Uint8Array(buffer);
      
      // Load the PDF document using Uint8Array instead of Buffer
      const loadingTask = getDocument({
        data: uint8Array,
        disableFontFace: true,
      });
      
      // Set a timeout to avoid hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('PDF processing timed out after 30 seconds')), 30000);
      });
      
      // Race against timeout
      const pdfDocument = await Promise.race([
        loadingTask.promise,
        timeoutPromise
      ]);

      let textContent = '';
      const numPages = pdfDocument.numPages;
      
      // Process each page
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
          const page = await pdfDocument.getPage(pageNum);
          const content = await page.getTextContent();
          
          // Extract and join text items
          const pageText = content.items
            .map(item => item.str || '')
            .join(' ');
            
          textContent += pageText + '\n\n';
        } catch (pageError) {
          console.warn(`Error extracting text from page ${pageNum}:`, pageError.message);
          // Continue with other pages even if one fails
        }
      }
      
      return textContent || "No text content extracted";
    } catch (error) {
      // Create a simple error without stack for safer handling
      safeLogError(error.message || 'Unknown PDF parsing error');
      
      // Fallback to text extraction
      try {
        const text = buffer.toString('utf-8');
        if (text && text.length > 100) {
          return text; // Use binary-to-string conversion as fallback
        }
      } catch (fallbackError) {
        // Ignore fallback errors
      }
      
      // Create a new error to avoid stack property issues
      const simpleError = new Error('Failed to parse PDF');
      throw simpleError;
    }
  },
  
  /**
   * Clean and normalize extracted PDF text
   * @param {string} text - Raw text extracted from PDF
   * @returns {string} - Cleaned text
   */
  cleanText: (text) => {
    if (!text || typeof text !== 'string') return '';
    
    try {
      // Remove excess whitespace
      let cleaned = text.replace(/\s+/g, ' ');
      
      // Normalize line breaks
      cleaned = cleaned.replace(/\r\n/g, '\n');
      
      // Remove common page markers and headers/footers
      cleaned = cleaned.replace(/Page \d+ of \d+/gi, '');
      cleaned = cleaned.replace(/^\d+$\n/gm, ''); // Remove standalone page numbers
      
      // Remove footer/header patterns (common in PDFs)
      cleaned = cleaned.replace(/^.{0,10}[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}.{0,10}$/gm, '');
      
      // Handle PDF artifact patterns
      cleaned = cleaned.replace(/\(cid:[^\)]+\)/g, '');
      
      // Additional pattern cleaning for technical documents
      cleaned = cleaned.replace(/^Document ID:.*$/gm, '');
      cleaned = cleaned.replace(/^Revision:.*$/gm, '');
      
      return cleaned.trim();
    } catch (error) {
      safeLogError('Error cleaning PDF text');
      return text || '';
    }
  }
};

export default pdfParser; 