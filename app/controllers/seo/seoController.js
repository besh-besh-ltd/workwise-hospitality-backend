import Config from '../../config/app.config.js';
import {
  logError
} from '../../helper/common.js';
import seoModel from '../../models/seoModel.js';
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import numberToWords from 'number-to-words';
import { selectPOTemplate } from '../../helper/poTemplateSelector.js';
import { buildPOTemplateData } from '../../helper/poTemplateDataBuilder.js';

const { toWords } = numberToWords;
import { Readable } from 'stream';
import axios from 'axios';

async function getBase64FromUrl(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const mimeType = response.headers['content-type'].toLowerCase();
  const base64 = buffer.toString('base64');
  return `data:image/png;base64,${base64}`;
}

const seoController = {
  productSlugForSitemap: async (req, res, next) => {
    try {
      const { page = 1, limit = 50000 } = req.query;
      const pageNumber = parseInt(page);
      const limitNumber = parseInt(limit);
      const offset = (pageNumber - 1) * limitNumber;

      const { productSlugList, total } = await seoModel.productSlugSitemap(limitNumber, offset);
      const slugArray = productSlugList.map((item) => item.slug);
      const responsePayload = {
          status: 1,
          data: slugArray,
          total: total,
          page: pageNumber,
          limit: limitNumber
      };

      res
        .status(200)
        .json(responsePayload)
        .end();
    } catch (error) {
        logError(error);
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
    }
  },
  poPDF : async (poData, txContext = null)=>{
    try {
    // --- Helpers ---
    // format currency INR style (2 decimals)
    Handlebars.registerHelper('formatCurrency', (num) => {
      const n = Number(num || 0);
      return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });
    // increment index for table numbering
    Handlebars.registerHelper('inc', (i) => Number(i) + 1);
    // newline to <br/>
    Handlebars.registerHelper('nl2br', (text) => {
      if (!text) return '';
      const escaped = Handlebars.escapeExpression(text);
      return new Handlebars.SafeString(escaped.replace(/\r\n|\r|\n/g, '<br/>'));
    });
    // amount in words (simple)
    Handlebars.registerHelper('amountInWords', (amount) => {
      const n = Number(amount || 0);
      const rupees = Math.floor(n);
      const paise = Math.round((n - rupees) * 100);
      const rupeeWords = rupees > 0 ? toWords(rupees) : 'zero';
      const paiseWords = paise > 0 ? toWords(paise) : null;
      let out = `${capitalize(rupeeWords)} Rupees`;
      if (paiseWords) out += ` and ${capitalize(paiseWords)} Paise`;
      out += ' Only';
      return out;
    });
    // capitalize helper for payment terms
    Handlebars.registerHelper('capitalize', (str) => {
      if (!str) return '';
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    });
    function capitalize(s) {
      if (!s) return s;
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    // equality helper for conditional styling
    Handlebars.registerHelper('eq', function(a, b, options) {
      if (a === b) {
        return options.fn(this);
      }
      return options.inverse(this);
    });
    // numeric add helper (used for sequential numbering with offsets)
    Handlebars.registerHelper('add', (a, b) => Number(a) + Number(b));

    // --- Dynamic Template Selection ---
    // If po_id and company context are provided, use dynamic template selection
    const { po_id, company_id, hospitality_company_id, hotel_id } = poData || {};

    let templatePath;
    if (company_id) {
      // Use dynamic template selection based on company hierarchy
      templatePath = selectPOTemplate(company_id, hospitality_company_id, hotel_id);
    } else {
      // Fallback to default template for backward compatibility
      templatePath = path.join(process.cwd(), 'app', 'helper', 'poTemplate.hbs');
    }

    if (!fs.existsSync(templatePath)) {
      return { ok: false, error: `Template not found at ${templatePath}` };
    }

    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = Handlebars.compile(templateSource);

    // --- Build template data ---
    let data;

    // If po_id is provided, use the enhanced data builder
    if (po_id) {
      try {
        data = await buildPOTemplateData(po_id, txContext);
        console.log(`Built PO template data for PO ${po_id}`);
      } catch (buildError) {
        console.error(`Error building PO template data for PO ${po_id}:`, buildError);
        // Fall back to provided poData if build fails
        data = { ...poData };
      }
    } else {
      // Legacy mode: Use placeholder data merged with provided poData
      const now = new Date();
      data = {
        po_number: `PO-${Date.now()}`,
        created_at: now.toLocaleDateString('en-GB'),
        quotationRef: 'QTN-0001',
        company_name: 'LAKSHYA POWERTECH LIMITED',
        company: {
          name: 'LAKSHYA POWERTECH LIMITED',
          address: 'SECOND FLOOR, T 109, CHIRA CHAS, ...',
          phone: '9998789770',
          email: 'keyurshah@lakshyapowertech.com',
          gstin: '20AACCL3031F1ZC',
          cin: 'L74900GJ2012PLC071218',
          logoUrl: null,
        },
        supplier: {
          name: 'CORAL SALES PVT LTD',
          address: 'FIRST FLOOR, SHATABDI TOWER, 1 SNP AREA, SAKCHI, JAMSHEDPUR ...',
          phone: '',
          email: 'coralsales2008@gmail.com',
          gstin: '20AADCC3326M1ZZ'
        },
        shipTo: 'JHARIA BLOCK, PARBATPUR-GCS, BOKARO ASSET, JHARKHAND',
        billTo: `
          LAKSHYA POWERTECH LIMITED\n
          SECOND FLOOR, T 109, CHIRA CHAS, OM\n
          SHREE\n
          TRYAMBAKESHWAR ENCLAVE ASHIYANA\n
          GARDEN,\n
          PHASE 4, Bokaro Steel City, Bokaro, Jharkhand,\n
          827013\n
          GSTIN : 20AACCL3031F1ZC\n
          PAN : AACCL3031F\n
        `,
        items: [
          {
            description: 'HYDRAULIC CRANE 23 TON MAKE ACE MODEL F-230 ...',
            hsn: '84261100',
            uom: 'NOS',
            quantity: 1,
            rate: 5148514.64,
            taxPercent: 18,
            lineTotal: 5148514.64,
            remark: ''
          },
          {
            description: 'OTHER EXPENSE - TCS(1%)',
            hsn: '',
            uom: 'NOS',
            quantity: 1,
            rate: 51485.15,
            taxPercent: 0,
            lineTotal: 51485.15
          },
          {
            description: 'OTHER EXPENSE - REGISTRATION & INSURANCE',
            hsn: '',
            uom: 'NOS',
            quantity: 1,
            rate: 441944.0,
            taxPercent: 0,
            lineTotal: 441944.0
          }
        ],
        subtotal: 5148514.64,
        taxAmount: 785366.64,
        otherChargesTotal: 0,
        discount: 0,
        total: 5641943.79,
        notes: `
          Warranty - Offered equipment is covered under our standard Warranty of Twelve months or 1000 hrs from the date of Commissioning whichever occurs earlier.
          Installation & Free Services - Local Dealer will provide free installation and 3 free services as per standard Customer Service schedule within Warranty period.
        `,
        warranty: '12 months or 1000 hrs from commissioning whichever earlier',
        delivery: '3 WEEKS FROM PO DATE',
      };

      // If the request provided data, shallow-merge it (keeps placeholders when request misses fields)
      if (poData && Object.keys(poData).length) {
        Object.assign(data, poData);
      }
    }

    if(data?.company?.logoUrl) {
      data.company.logoUrlBase64 = await getBase64FromUrl(data.company.logoUrl)
    }

    if (data.created_at) {
      const createdInDate = new Date(data.created_at);
      // Convert UTC to IST (UTC+5:30)
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const ist = new Date(createdInDate.getTime() + IST_OFFSET_MS);
      const day = String(ist.getUTCDate()).padStart(2, '0');
      const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
      const year = ist.getUTCFullYear();
      data.created_at = `${day}/${month}/${year}`;
    }

    if (data.timestamp) {
      const createdInDate = new Date(data.timestamp);
      // Convert UTC to IST (UTC+5:30)
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const ist = new Date(createdInDate.getTime() + IST_OFFSET_MS);
      const day = String(ist.getUTCDate()).padStart(2, '0');
      const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
      const year = ist.getUTCFullYear();
      data.timestamp = `${day}/${month}/${year}`;
    }

    // --- Render HTML ---
    const html = template(data);


    // --- Ensure output folder exists ---
    const storageDir = path.join(process.cwd(), 'app', 'storage', 'invoices');
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

    const fileName = `po-${data.po_number}.pdf`;
    const fullPath = path.join(storageDir, fileName);

    // --- Launch puppeteer and create PDF ---
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // ensure print background and A4
    await page.pdf({
      path: fullPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }
    });

    await browser.close();

    // --- Return result ---
    return {
      ok: true,
      message: 'PO PDF created',
      file: `/app/storage/invoices/${fileName}`,
      absolutePath: fullPath
    };
  } catch (err) {
    console.error('createPoPDF error:', err);
    return { ok: false, error: err.message || 'Failed to create PDF' };
  }
}
  ,
 vendorSitemap : async (req, res, next) => {
  try {
    const { page = 1, limit = 50000 } = req.query;
    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);

    if (isNaN(pageNumber) || pageNumber < 1 || isNaN(limitNumber) || limitNumber < 1) {
      res.status(400).json({ status: 3, message: 'Invalid page or limit' }).end();
      return;
    }

    const offset = (pageNumber - 1) * limitNumber;

    // Create a readable stream for the sitemap
    const stream = new Readable({
      read() {}
    });

    // Set response headers
    res.set('Content-Type', 'application/xml');

    // Write XML header
    stream.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    stream.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n');

    // Pipe the stream to the response
    stream.pipe(res);

    // Generate and stream URLs
    for await (const url of seoModel.vendorSitemapUrls(limitNumber, offset)) {
      stream.push(url);
    }

    // Close the XML and stream
    stream.push('</urlset>\n');
    stream.push(null); // Signal end of stream

  } catch (error) {
    console.error('Error generating sitemap:', error);
    if (!res.headersSent) {
      res.status(400).json({ status: 3, message: 'Error generating sitemap' }).end();
    }
  }
},
vendorSitemapIndex: async (req, res, next) => {
  try {
    const { totalUrls } = await seoModel.getVendorSitemapTotal();
    const limit = 50000;
    const totalPages = Math.ceil(totalUrls / limit);
    const baseUrl = process.env.FRONTEND_URL || "https://letsworkwise.com";

    res.set("Content-Type", "application/xml");

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (let i = 1; i <= totalPages; i++) {
      xml += `  <sitemap>\n`;
      xml += `    <loc>${baseUrl}/vendors/sitemap/${i}.xml</loc>\n`;
      xml += `  </sitemap>\n`;
    }

    xml += "</sitemapindex>";

    res.send(xml);
  } catch (error) {
    console.error("Error generating sitemap index:", error);
    if (!res.headersSent) {
      res.status(500).json({ status: 3, message: "Error generating sitemap index" });
    }
  }
},
categorySitemap : async (req, res, next) => {
  try {
    const { page = 1, limit = 50000 } = req.query;
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);

    if (isNaN(pageNumber) || pageNumber < 1 || isNaN(limitNumber) || limitNumber < 1) {
      return res.status(400).json({ status: 3, message: 'Invalid page or limit' });
    }

    const offset = (pageNumber - 1) * limitNumber;

    // Setup streaming response
    const stream = new Readable({ read() {} });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);

    // XML header
    stream.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    stream.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n');

    // Stream URLs from generator
    for await (const url of seoModel.getCategoryAndVariantUrls(limitNumber, offset)) {
      stream.push(url);
    }

    // Close XML
    stream.push('</urlset>\n');
    stream.push(null);

  } catch (error) {
    console.error('Error generating category sitemap:', error);
    if (!res.headersSent) {
      res.status(500).json({ status: 3, message: 'Error generating category sitemap' });
    }
  }
},
categorySitemapIndex: async (req, res, next) => {
  try {
    const { totalUrls } = await seoModel.getCategorySitemapTotal();

    console.log("Total Category URLs:", totalUrls);
    const limit = 50000;
    const totalPages = Math.ceil(totalUrls / limit);
    const baseUrl = process.env.FRONTEND_URL || "https://letsworkwise.com";

    res.set("Content-Type", "application/xml");

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (let i = 1; i <= totalPages; i++) {
      xml += `  <sitemap>\n`;
      xml += `    <loc>${baseUrl}/category/sitemap/${i}.xml</loc>\n`;
      xml += `  </sitemap>\n`;
    }

    xml += "</sitemapindex>";

    res.send(xml);
  } catch (error) {
    console.error("Error generating category sitemap index:", error);
    if (!res.headersSent) {
      res.status(500).json({
        status: 3,
        message: "Error generating category sitemap index",
      });
    }
  }
}


};



export default seoController;
