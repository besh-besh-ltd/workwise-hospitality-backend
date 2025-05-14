// Changes by Agnij 2025-05-14 [Enhanced PDF parser with more robust extraction]
import pkg from 'pdfjs-dist';
const { getDocument } = pkg;
import { logError } from './common.js';
import fs from 'fs';
import path from 'path';
// Changes by Agnij 2025-05-14 [Fix module import error]
// Removed TypeScript type import that doesn't exist as JS module

// Set up worker source path for Node environment
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

// Safe error logging
const safeLogError = (message) => {
  console.error('PDF Parser Error:', message);
};

// Changes by Agnij May 14, 2025 [Enhanced PDF parser with better grouping of related clauses]
const pdfParser = {
  /**
   * Parse a PDF buffer and extract text content with preserved formatting and better clause grouping
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
      let structuredSections = [];
      const numPages = pdfDocument.numPages;
      
      // First pass: collect all text items with positioning information
      let allTextItems = [];
      
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
          const page = await pdfDocument.getPage(pageNum);
          const content = await page.getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: false
          });
          
          // Get page viewport for positioning
          const viewport = page.getViewport({ scale: 1.0 });
          const pageHeight = viewport.height;
          
          // Add page number and mapping to text items
          const pageItems = content.items.map(item => ({
            ...item,
            pageNum,
            pageHeight,
            // Calculate normalized positions for consistent cross-page analysis
            normalizedY: pageHeight - item.transform[5], // Y from top
            normalizedX: item.transform[4], // X from left
            // Calculate font size based on transform matrix
            fontSize: Math.sqrt(item.transform[2] * item.transform[2] + item.transform[3] * item.transform[3])
          }));
          
          allTextItems = allTextItems.concat(pageItems);
        } catch (pageError) {
          console.warn(`Error processing page ${pageNum}:`, pageError.message);
        }
      }
      
      // Sort all items by page and top-to-bottom position
      allTextItems.sort((a, b) => {
        if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
        return a.normalizedY - b.normalizedY;
      });
      
      // Second pass: identify headings, sections, and group related items
      const detectHeadings = () => {
        // Calculate average font size
        const fontSizes = allTextItems.map(item => item.fontSize).filter(Boolean);
        const avgFontSize = fontSizes.reduce((sum, size) => sum + size, 0) / fontSizes.length;
        
        // Identify potential headings (larger font, centered, or all caps)
        return allTextItems.map((item, idx) => {
          const isLargerFont = item.fontSize > avgFontSize * 1.2;
          const isPossiblyAllCaps = item.str === item.str.toUpperCase() && item.str.length > 3;
          const isIndented = item.normalizedX < 50; // Left-aligned/indented items
          const nextItem = idx < allTextItems.length - 1 ? allTextItems[idx + 1] : null;
          
          // Check if next item starts significantly below (section gap)
          const hasGapAfter = nextItem && 
            nextItem.pageNum === item.pageNum && 
            (nextItem.normalizedY - item.normalizedY) > avgFontSize * 1.5;
          
          // Common section heading patterns
          const headingPatterns = [
            /^(section|chapter)\s+\d+/i,
            /^\d+\.\s+[A-Z]/,
            /^[IVX]+\.\s+/,
            /^[A-Z][A-Z\s]+:$/,
            /^(IMPORTANT NOTE|NOTE|WARNING|CAUTION)S?:/i,
            /^(Technical\s+Specification|General\s+Requirements|Standards|Notes)/i,
            /^(VTA|TBA)$/i,
            /^(VTA|TBA)\s*[-:]/i,
            /^Flow\s+\(/i,
            /^(Specification|Requirements|Dimensions|Material|Parameters)/i,
          ];
          
          const matchesPattern = headingPatterns.some(pattern => pattern.test(item.str));
          
          // Check for specific abbreviations that should be grouped
          const commonAbbreviations = ['VTA', 'TBA', 'VAT', 'PO', 'QC', 'QA'];
          const isCommonAbbreviation = commonAbbreviations.some(abbr => 
            item.str.includes(abbr) || item.str === abbr);
          
          return {
            ...item,
            isHeading: isLargerFont || (isPossiblyAllCaps && hasGapAfter) || matchesPattern,
            headingLevel: isLargerFont ? 1 : (isPossiblyAllCaps ? 2 : (matchesPattern ? 2 : 0)),
            isListItem: item.str.match(/^[\d•\-*][\.\s]/),
            isNotesItem: item.str.match(/^(Note|N\.B\.|NB)[\s\d:\.]/i) || item.str.match(/^([•\*]\s)/),
            isCommonAbbreviation
          };
        });
      };
      
      const enrichedItems = detectHeadings();
      
      // Group items into structured sections
      const groupIntoSections = (items) => {
        const sections = [];
        let currentSection = { heading: null, items: [], level: 0 };
        let currentSubsection = null;
        
        items.forEach((item, idx) => {
          if (item.isHeading && (!currentSection.heading || item.headingLevel <= currentSection.level)) {
            // Start a new main section
            if (currentSection.items.length > 0) {
              sections.push(currentSection);
            }
            currentSection = { 
              heading: item.str,
              items: [],
              level: item.headingLevel,
              pageNum: item.pageNum,
              fontAttributes: {
                size: item.fontSize,
                isAllCaps: item.str === item.str.toUpperCase() && item.str.length > 3
              }
            };
            currentSubsection = null;
          } else if (item.isHeading && currentSection.heading && item.headingLevel > currentSection.level) {
            // Start a new subsection
            currentSubsection = {
              heading: item.str,
              items: [],
              level: item.headingLevel,
              pageNum: item.pageNum
            };
            currentSection.subsections = currentSection.subsections || [];
            currentSection.subsections.push(currentSubsection);
          } else if (item.isListItem || item.isNotesItem) {
            // Add to current subsection or section as a list item
            if (currentSubsection) {
              currentSubsection.items.push(item);
            } else {
              currentSection.items.push(item);
            }
          } else if (item.isCommonAbbreviation && idx < items.length - 1) {
            // For abbreviations like VTA/TBA, group with the next item if it's close
            const nextItem = items[idx + 1];
            if (nextItem && Math.abs(nextItem.normalizedY - item.normalizedY) < item.fontSize * 2) {
              // Create a special paired item
              const combinedItem = {
                ...item,
                str: `${item.str}: ${nextItem.str}`,
                isPaired: true,
                originalItems: [item, nextItem]
              };
              
              if (currentSubsection) {
                currentSubsection.items.push(combinedItem);
              } else {
                currentSection.items.push(combinedItem);
              }
              
              // Skip the next item since we've included it in the pair
              items[idx + 1].isProcessed = true;
            } else {
              // Add as a normal item
              if (currentSubsection) {
                currentSubsection.items.push(item);
              } else {
                currentSection.items.push(item);
              }
            }
          } else if (!item.isProcessed) {
            // Add to current subsection or section
            if (currentSubsection) {
              currentSubsection.items.push(item);
            } else {
              currentSection.items.push(item);
            }
          }
        });
        
        // Add the last section
        if (currentSection.items.length > 0 || (currentSection.subsections && currentSection.subsections.length > 0)) {
          sections.push(currentSection);
        }
        
        return sections;
      };
      
      const sections = groupIntoSections(enrichedItems);
      
      // Detect and process tables
      const processTablesInSections = (sections) => {
        return sections.map(section => {
          // Check for potential table patterns in consecutive items
          const hasTableItems = section.items.some((item, idx, items) => {
            if (idx < items.length - 3) {
              // Check for aligned items that might form table columns
              const xPositions = new Set([
                item.normalizedX,
                items[idx + 1].normalizedX,
                items[idx + 2].normalizedX
              ]);
              
              return xPositions.size >= 2; // At least two distinct column positions
            }
            return false;
          });
          
          if (hasTableItems) {
            // Group items by row position
            const rowGroups = {};
            section.items.forEach(item => {
              // Round Y position to group items in the same row
              const rowKey = Math.round(item.normalizedY / 5) * 5;
              rowGroups[rowKey] = rowGroups[rowKey] || [];
              rowGroups[rowKey].push(item);
            });
            
            // Sort rows by Y position
            const sortedRows = Object.keys(rowGroups)
              .sort((a, b) => parseInt(a) - parseInt(b))
              .map(key => {
                const row = rowGroups[key];
                // Sort items in the row by X position
                return row.sort((a, b) => a.normalizedX - b.normalizedX);
              });
            
            // Convert to structured table
            section.isTable = true;
            section.tableRows = sortedRows.map(row => 
              row.map(item => item.str)
            );
            
            // Create a text representation of the table
            section.tableText = sortedRows.map(row => 
              row.map(item => item.str).join('   ')
            ).join('\n');
          }
          
          // Process subsections recursively
          if (section.subsections && section.subsections.length > 0) {
            section.subsections = processTablesInSections(section.subsections);
          }
          
          return section;
        });
      };
      
      const sectionsWithTables = processTablesInSections(sections);
      
      // Generate formatted text
      const formatSectionsToText = (sections, level = 0) => {
        let text = '';
        const indent = '  '.repeat(level);
        
        sections.forEach(section => {
          // Add section heading
          if (section.heading) {
            text += `${indent}${section.heading}\n`;
          }
          
          // Add section content
          if (section.isTable && section.tableText) {
            text += `${indent}${section.tableText}\n\n`;
          } else {
            // Add regular items
            section.items.forEach(item => {
              if (item.isPaired) {
                text += `${indent}${item.str}\n`;
              } else {
                text += `${indent}${item.str}\n`;
              }
            });
            
            // Add a newline after non-empty sections
            if (section.items.length > 0) {
              text += '\n';
            }
          }
          
          // Add subsections
          if (section.subsections && section.subsections.length > 0) {
            text += formatSectionsToText(section.subsections, level + 1);
          }
        });
        
        return text;
      };
      
      fullText = formatSectionsToText(sectionsWithTables);
      structuredSections = sectionsWithTables;
      
      // Store the structured sections for retrieval by other methods
      this._lastStructuredSections = structuredSections;
      
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
      
      // Fix abbreviations and ensure they're properly formatted
      cleaned = cleaned.replace(/\bVTA\b(?!\s*[:-])/g, 'VTA:'); // Add colon if missing
      cleaned = cleaned.replace(/\bTBA\b(?!\s*[:-])/g, 'TBA:'); // Add colon if missing
      
      // Preserve relationships between flow values
      cleaned = cleaned.replace(/(\d+)\s*-\s*(\d+)/g, '$1-$2'); // Keep ranges together
      cleaned = cleaned.replace(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g, '$1 / $2 / $3'); // Format flow values
      
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
      
      // Group related items like VTA/TBA with their descriptions
      cleaned = cleaned.replace(/\b(VTA|TBA)\s*[:.-]?\s*([A-Z0-9])/g, '$1: $2');
      
      // Ensure flow values are properly formatted
      cleaned = cleaned.replace(/Flow\s+\(min\s*\/\s*nor\s*\/\s*max\)\s+(\d+)-(\d+\.\d+)/g, 
                              'Flow (min / nor / max)  $1 / $1 / $2');
      
      // Remove duplicate lines that often appear in PDF extraction
      const lines = cleaned.split('\n');
      const uniqueLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (i === 0 || lines[i] !== lines[i-1]) {
          uniqueLines.push(lines[i]);
        }
      }
      cleaned = uniqueLines.join('\n');
      
      // Changes by Agnij 2025-05-14 [Robust value range normalization for all parameters]
      // Normalize all value ranges (e.g., 964-1060.4, 10-20, 5.5-7.8) into min/normal/max format
      cleaned = cleaned.replace(/(\b\w+\b)[^\S\r\n]*[:=]?[^\S\r\n]*([\d\.]+)\s*-\s*([\d\.]+)/g, (match, param, minOrNor, max) => {
        // If minOrNor and max are both numbers, format as min / nor / max
        const minNum = parseFloat(minOrNor);
        const maxNum = parseFloat(max);
        if (!isNaN(minNum) && !isNaN(maxNum)) {
          // If the parameter name contains min/nor/max, don't reformat
          if (/min|nor|max/i.test(param)) return match;
          // Use min = half of normal if min < max, else just repeat min
          const minVal = minNum < maxNum ? (minNum / 2).toFixed(2) : minNum.toFixed(2);
          const norVal = minNum.toFixed(2);
          const maxVal = maxNum.toFixed(2);
          return `${param}: ${minVal} / ${norVal} / ${maxVal}`;
        }
        return match;
      });
      
      return cleaned.trimEnd();
    } catch (error) {
      safeLogError('Error cleaning PDF text: ' + error.message);
      // Return original text as fallback
      return text || '';
    }
  },
  
  /**
   * Get the last extracted structured sections
   * @returns {Array} - Structured sections with headings and content
   */
  getStructuredSections: function() {
    return this._lastStructuredSections || [];
  }
};

export default pdfParser; 