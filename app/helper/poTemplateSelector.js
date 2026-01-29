import fs from 'fs';
import path from 'path';

/**
 * Select the most appropriate PO template based on company hierarchy
 * Priority: company+hospitality+hotel > company+hospitality > company > default
 *
 * Template naming convention: {company_id}_{hospitality_company_id}_{hotel_id}.hbs
 * The hospitality_company_id and hotel_id are optional
 *
 * @param {number} company_id - User's main company ID
 * @param {number} hospitality_company_id - Hospitality company ID (optional)
 * @param {number} hotel_id - Hotel ID (optional)
 * @returns {string} - Absolute path to the template file
 */
export const selectPOTemplate = (company_id, hospitality_company_id, hotel_id) => {
  const templatesDir = path.join(process.cwd(), 'app', 'helper', 'poTemplates');
  const defaultTemplate = path.join(process.cwd(), 'app', 'helper', 'poTemplate.hbs');

  // Priority order: most specific to least specific
  const candidates = [];

  // 1. Most specific: company_id + hospitality_company_id + hotel_id
  if (company_id && hospitality_company_id && hotel_id) {
    candidates.push(`${company_id}_${hospitality_company_id}_${hotel_id}.hbs`);
  }

  // 2. company_id + hospitality_company_id
  if (company_id && hospitality_company_id) {
    candidates.push(`${company_id}_${hospitality_company_id}.hbs`);
  }

  // 3. company_id only
  if (company_id) {
    candidates.push(`${company_id}.hbs`);
  }

  // Check each candidate in order
  for (const candidate of candidates) {
    const templatePath = path.join(templatesDir, candidate);
    if (fs.existsSync(templatePath)) {
      console.log(`Selected PO template: ${candidate}`);
      return templatePath;
    }
  }

  // Fallback to default template
  console.log('Using default PO template');
  return defaultTemplate;
};
