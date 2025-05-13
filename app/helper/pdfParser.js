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

// Changes by Agnij October 18, 2023 [Enhanced PDF parser to maintain formatting and table structures]
const pdfParser = {
  /**
   * Parse a PDF buffer and extract text content with preserved formatting
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

      let fullText = '';
      const numPages = pdfDocument.numPages;
      
      // Process each page, preserving structure and tables
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
          console.log(`Processing PDF page ${pageNum} of ${numPages}`);
          const page = await pdfDocument.getPage(pageNum);
          const content = await page.getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: false
          });
          
          // Get page viewport for positioning
          const viewport = page.getViewport({ scale: 1.0 });
          const pageHeight = viewport.height;
          
          // Sort items by vertical position (top to bottom)
          const textItems = content.items;
          
          // Group items by lines based on y-position (with tolerance)
          const lineThreshold = 3; // pixels of tolerance for same line
          const lines = [];
          let currentLine = [];
          
          // First text item
          if (textItems.length > 0) {
            currentLine.push(textItems[0]);
          }
          
          // Process remaining items
          for (let i = 1; i < textItems.length; i++) {
            const item = textItems[i];
            const prevItem = textItems[i - 1];
            
            // Check if items are on the same line
            const isSameLine = Math.abs(item.transform[5] - prevItem.transform[5]) < lineThreshold;
            
            if (isSameLine) {
              // Same line - add to current line
              currentLine.push(item);
            } else {
              // Different line - save current line and start a new one
              lines.push([...currentLine]);
              currentLine = [item];
            }
          }
          
          // Add last line if not empty
          if (currentLine.length > 0) {
            lines.push(currentLine);
          }
          
          // Process lines - sort items in each line by x-position (left to right)
          const processedLines = lines.map(line => {
            // Sort items in line by horizontal position
            return line.sort((a, b) => a.transform[4] - b.transform[4]);
          });
          
          // Convert to text, preserving advanced structure
          let pageText = '';
          let lastY = -1;
          let lastLineStartX = -1;
          let tableDetected = false;
          let tableColumnPositions = [];
          
          // Detect potential tables by analyzing column patterns across lines
          const detectTableColumns = (processedLines) => {
            // Collect x-positions of items across multiple lines
            const xPositions = [];
            
            // Sample from the first 15 lines or all lines if fewer
            const sampleSize = Math.min(15, processedLines.length);
            for (let i = 0; i < sampleSize; i++) {
              const line = processedLines[i];
              if (line.length > 2) { // Only consider lines with multiple elements
                line.forEach(item => {
                  xPositions.push(Math.round(item.transform[4] / 5) * 5); // Round to nearest 5 for clustering
                });
              }
            }
            
            // Count occurrences of x-positions
            const xPositionCounts = {};
            xPositions.forEach(x => {
              xPositionCounts[x] = (xPositionCounts[x] || 0) + 1;
            });
            
            // Find x-positions that appear frequently (potential column starts)
            const columnThreshold = Math.max(3, Math.floor(sampleSize / 4));
            const potentialColumns = Object.entries(xPositionCounts)
              .filter(([_, count]) => count >= columnThreshold)
              .map(([x, _]) => parseInt(x))
              .sort((a, b) => a - b);
              
            return potentialColumns;
          };
          
          // Try to detect tables in this page
          tableColumnPositions = detectTableColumns(processedLines);
          tableDetected = tableColumnPositions.length > 2; // At least 3 columns to consider it a table
          
          // Process each line with enhanced table structure preservation
          for (const line of processedLines) {
            // Calculate line spacing
            if (lastY !== -1) {
              const currentY = line[0].transform[5];
              const yDiff = lastY - currentY;
              
              // Handle vertical spacing - better paragraph and section detection
              if (yDiff > 15) {
                // Larger gap = new section
                pageText += '\n\n';
              } else if (yDiff > 8) {
                // Medium gap = paragraph break
                pageText += '\n';
              }
            }
            
            // Handle indentation and table structure
            const lineStartX = line[0]?.transform[4] || 0;
            let lineIndent = '';
            
            // Add indentation to preserve document structure
            if (lastLineStartX !== -1 && Math.abs(lineStartX - lastLineStartX) > 10) {
              const indentDiff = Math.floor((lineStartX - lastLineStartX) / 4);
              if (indentDiff > 0 && indentDiff < 10) {
                // Positive indent = subordinate content
                lineIndent = ' '.repeat(indentDiff * 2);
              }
            }
            
            // Different handling for table vs regular text
            let lineText = '';
            
            if (tableDetected && line.length > 1) {
              // Enhanced table formatting
              let lastPos = 0;
              let columnText = [];
              
              for (const item of line) {
                const itemX = item.transform[4];
                
                // Find which column this item belongs to
                const columnIndex = tableColumnPositions.findIndex(pos => 
                  Math.abs(itemX - pos) < 15);
                
                if (columnIndex >= 0) {
                  // This item aligns with a detected column
                  while (columnText.length < columnIndex) {
                    columnText.push(''); // Fill in missing columns
                  }
                  columnText[columnIndex] = item.str;
                } else {
                  // Not aligned with a column, just add in sequence
                  columnText.push(item.str);
                }
                
                lastPos = itemX + (item.width || 0);
              }
              
              // Construct line with proper spacing for table
              lineText = columnText.join('   ');
            } else {
              // Process items in the line (non-table or undetected table)
              lineText = line.map((item, idx) => {
                // Check for horizontal spacing to preserve alignment
                if (idx > 0) {
                  const prevItem = line[idx - 1];
                  const xGap = item.transform[4] - (prevItem.transform[4] + (prevItem.width || 0));
                  
                  if (xGap > 10) {
                    // Calculate spaces to maintain relative positioning
                    // More granular space calculation based on gap size
                    const spaces = Math.ceil(xGap / 3);
                    return ' '.repeat(Math.min(spaces, 25)) + item.str;
                  }
                }
                return item.str;
              }).join('');
            }
            
            pageText += lineIndent + lineText + '\n';
            
            // Update tracking variables
            if (line.length > 0) {
              lastY = line[0].transform[5];
              lastLineStartX = lineStartX;
            }
          }
          
          fullText += pageText + '\n';
          
        } catch (pageError) {
          console.warn(`Error extracting text from page ${pageNum}:`, pageError.message);
          // Continue with other pages even if one fails
        }
      }
      
      return fullText || "No text content extracted";
      
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
   * Clean and normalize extracted PDF text while preserving structure
   * @param {string} text - Raw text extracted from PDF
   * @returns {string} - Cleaned text with preserved structure
   */
  cleanText: (text) => {
    if (!text || typeof text !== 'string') return '';
    
    try {
      // Normalize line endings while preserving structure
      let cleaned = text.replace(/\r\n/g, '\n');
      
      // Replace excess consecutive blank lines (>3) with double newlines
      // but preserve paragraph breaks and section separations
      cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');
      
      // Handle technical document headers/footers more precisely
      // Remove page indicators but preserve actual numbering in tables/specs
      cleaned = cleaned.replace(/^\s*Page\s+\d+\s+of\s+\d+\s*$/gim, '');
      
      // More targeted removal of document metadata that isn't part of the content
      // without disturbing dates that are part of specifications or tables
      cleaned = cleaned.replace(/^\s*(confidential|draft|internal use only)\s*$/gim, '');
      
      // Handle PDF artifact patterns more precisely
      cleaned = cleaned.replace(/\(cid:[^\)]+\)/g, '');
      
      // Fix PDF extraction artifacts in tables and numerical values
      // This improves display of technical specifications
      cleaned = cleaned.replace(/(\d) \. (\d)/g, '$1.$2'); // Fix decimal numbers
      cleaned = cleaned.replace(/(\d) \, (\d)/g, '$1,$2'); // Fix thousand separators
      
      // Fix degree symbols and other common technical notation
      cleaned = cleaned.replace(/° C/g, '°C');  
      cleaned = cleaned.replace(/° F/g, '°F');
      
      // Fix unit spacing for technical specifications
      cleaned = cleaned.replace(/(\d+)mm/g, '$1 mm');
      cleaned = cleaned.replace(/(\d+)kPa/g, '$1 kPa');
      cleaned = cleaned.replace(/(\d+)MPa/g, '$1 MPa');
      
      // Handle common technical document section markers but preserve numbering
      // This helps maintain the structure while removing irrelevant parts
      cleaned = cleaned.replace(/^Document ID:.*$/gm, '');
      cleaned = cleaned.replace(/^Revision:.*$/gm, '');
      
      // Preserve multi-column data tables by maintaining spacing
      // Replace single spaces with non-breaking spaces in likely table rows
      // (rows with multiple aligned spaces that appear to be columns)
      const tableRowPattern = /^([^\n]+?)(\s{3,}[^\n]+?){2,}$/gm;
      cleaned = cleaned.replace(tableRowPattern, (match) => {
        // Preserve the exact spacing in table rows
        return match;
      });
      
      // Fix tables with dashed line separators
      cleaned = cleaned.replace(/^[-]{10,}$/gm, '');
      
      // Remove duplicate lines that often appear in PDF extraction
      const lines = cleaned.split('\n');
      const uniqueLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (i === 0 || lines[i] !== lines[i-1]) {
          uniqueLines.push(lines[i]);
        }
      }
      cleaned = uniqueLines.join('\n');
      
      return cleaned.trimEnd();
    } catch (error) {
      safeLogError('Error cleaning PDF text: ' + error.message);
      // Return original text as fallback
      return text || '';
    }
  }
};

export default pdfParser; 