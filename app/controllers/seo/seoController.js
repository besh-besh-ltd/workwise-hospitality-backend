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
  poPDF : async (poData)=>{
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
    function capitalize(s) {
      if (!s) return s;
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // --- Template path ---
    // Use project root to resolve path so it works whether using __dirname or ESM
    const templatePath = path.join(process.cwd(), 'app', 'helper', 'poTemplate.hbs');

    if (!fs.existsSync(templatePath)) {
      return { ok: false, error: `Template not found at ${templatePath}` };
    }

    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = Handlebars.compile(templateSource);

    // --- Placeholder data (simple). Replace or merge with req.body as needed ---
    const now = new Date();
    const data = {
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
      terms: `Terms & Condition : 1. Object and scope\n
      1.1 These terms and conditions of purchase (“Standard Terms and Conditions”) shall apply to any purchase order (“Purchase Order”) for the purchase of products (“Products”)
      and/or services (“Services”) by Lakshya Powertech Private Limited(LPPL) (“Buyer”) from a supplier (“Supplier”, together with the Buyer, the “Parties” and each a “Party”), unless
      otherwise mutually agreed in writing by the Parties. A Purchase Order constitutes an offer by the Buyer to purchase Services and/or Products from the Supplier and shall be deemed
      to be accepted on the earlier of:
      (i) The Supplier issuing written acceptance of the Purchase Order, or
      (ii) Act by the Supplier consistent with fulfilling the Purchase Order, at which point, and on which date, a contract (“Contract”) shall come into existence. No document issued by the
      Supplier after receipt of the Buyer’s Purchase Order shall be construed as a counter-offer nor shall it apply in any way to alter these Standard Terms and Conditions.
      1.2 Special terms and conditions (“Special Terms and Conditions”) expressly referred to in a Purchase Order may amend these Standard Terms and Conditions. These Standard Terms
      and Conditions, as amended by Special Terms and Conditions, if any, shall apply to the exclusion of any other terms and conditions whether contained in the Supplier’s: (i) quotation,
      (ii) acceptance of a Purchase Order, or (iii) otherwise.
      1.3 A Contract and the related supply of Services and/or Products by the Supplier shall be subject to (in this order of priority unless otherwise expressly provided in the Special Terms
      and Conditions):
      (i) The Special Terms and Conditions
      (ii) These Standard Terms and Conditions
      (iii) Any document expressly included by reference in the Special Terms and Conditions, including without limitation, any special instructions (technical documentation, quality
      assurance, safety), the specified quantity of Products, quality, performance and/or timeframe/delivery dates, (together with the Special Terms and Conditions and the Standard
      Terms
      and Conditions, the “Terms and Conditions”); and
      (iv) The Supplier's commercial offer, to the extent that it is agreed in writing by the Buyer and it does not conflict with the Terms and Conditions.
      The Supplier shall be deemed to have read and understood all the Terms and Conditions and is responsible for its assessment of the inherent risks and uncertainties and any
      potential
      difficulties that may be encountered by the Supplier in the performance of the Services or delivery of the Products. Moreover, the Supplier undertakes to request and verify all the
      documents or technical information necessary for the performance of its obligations pursuant to a Purchase Order. No amendment or modification of a Contract by the Supplier will
      be binding upon the Buyer without the Buyer’s prior written approval.
      2. Performance of a Contract
      2.1 Timely Performance: The Supplier shall provide the Services and any deliverables required there under and/or deliver the Products according to the timeframes and delivery
      dates
      set out in a Purchase Order or as otherwise agreed by the Buyer in writing. The Supplier shall promptly notify the Buyer of any event which could adversely affect the scheduled
      timeframes and delivery dates for the performance of the Services and/or delivery of the Products.
      2.2 Standard of Performance: The Supplier shall perform all of its obligations under a Contract in strict accordance with the terms of the Contract, in a professional, commercially
      and
      diligent manner, and in accordance with generally accepted industry and professional standards, procedures and practices, to the reasonable satisfaction of Buyer. The Supplier
      agrees that the Services and/or Products that it provides to the Buyer will be fit for the purpose and use for which they are intended and compliant with all applicable laws, statutes,
      ordinances, codes, rules, regulations, orders, decrees or any other governmental, administrative or judicial pronouncements (collectively, “Laws”) and shall conform with all
      requirements set out in a Purchase Order or otherwise notified by the Buyer to the Supplier, be free of any defects in material and workmanship and be usable under normal
      conditions
      of use.
      2.3 Delivery: Unless otherwise specified in the Special Terms and Conditions, the Supplier will deliver the Products and/or provide the Services and any deliverables required
      thereunder to the location agreed between the Parties in writing and the Supplier will bear all the risk and expense of delivery, including without limitation, all costs associated with
      clearance through customs, it being understood that unless otherwise agreed in writing by the Buyer, the Buyer will not accept any tolerance margin in respect of the quantities of
      Products ordered. Title to the Products shall pass to the Buyer only upon delivery to the location agreed between Parties.
      2.4 Acceptance: If all or any part of the Services and/or Products do not comply with the specifications of a Purchase Order or are defective in any way, the Buyer may refuse to
      accept the non-complying Services and/or Products or accept them subject to any reservations or reduction to costs expressed by the Buyer. The simple act of taking delivery of the
      Products by the reception service cannot be regarded as acceptance. The Products acceptance will take place only after a complete verification by the Buyer. If the Buyer refuses to
      accept the defective or non-complying Products and/or Services, the Supplier will, at the Buyer’s option, re-perform, repair or replace the non-complying Services and/or Products as
      quickly as possible, at no cost to the Buyer and reimburse the Buyer for any expenses unduly incurred by the Buyer, including any costs of return shipping, without prejudice to any
      other rights the Buyer may have. Notwithstanding the above, the Buyer reserves the right to reject all or any part of the Products with respect to any latent defects, which shall
      include
      any defects that may not be detected by the Buyer through standard inspection and testing of a Product sample or that may affect only a portion of Product.
      2.5 Supervision: The Supplier is solely responsible for the supervision and management of its agents, appointees, employees and permitted subcontractors. The Supplier’s agents,
      appointees, employees and permitted subcontractors remain under the Supplier’s sole control, authority and management at all times during the performance of the Contract. No
      employee or agent engaged by the Supplier shall be, or shall be deemed to be, an employee or agent of the Buyer and shall not be entitled to any benefits that the Buyer provides to
      its own employees.
      2.6 Sub-Contracting: Unless otherwise agreed in the Special Terms and Conditions, the Supplier shall not subcontract all or any part of its obligations under the Order without the
      Buyer's prior approval. If required, the Buyer’s prior approval must be obtained in respect of each subcontractor. Notwithstanding the appointment of a permitted subcontractor, the
      Supplier shall remain fully responsible for the supply of Services and/or Products and such appointment shall not diminish or otherwise affect the Supplier’s obligations under a
      Contract.
      2.7 Compliance with Laws: The Supplier shall comply, and shall cause its subcontractors to comply, with all applicable Laws, and shall have all professional licenses, permits,
      certificates and registrations required for its performance of the Services.
      2.7.1 Environmental Health and Safety: The Supplier must ensure that its personnel and the personnel of any permitted subcontractors comply with all applicable Laws and the
      Buyer’s policies relating to environment, health and safety within the Buyer's premises or any other premises which are accessed or used pursuant to a Contract; under no
      circumstances will the Buyer be held liable for any incident arising as a result of a Supplier’s failure to comply with such Laws and/or policies. The Supplier shall provide to the Buyer
      all information related to the safety, safe handling, environmental impact, and disposal of the Products including, without limitation, material safety data sheets, it being understood
      that the Supplier shall promptly deliver to the Buyer, as it becomes available to the Supplier, any updates or amendments to the information provided pursuant to this Section. The
      Supplier shall be solely responsible for the generation, collection, storage, handling, transportation, movement and disposal of all waste (hazardous and non-hazardous), as
      applicable,
      in compliance with applicable Laws.
      2.7.2 Labour: The Supplier shall comply throughout the performance of a Contract with all the obligations incumbent upon it in application of the applicable labour Laws applicable
      in the country where the Products are manufactured or the Services performed. In particular, the Supplier shall provide the Buyer with the evidence of payment of social security
      contributions due by the Supplier. The Supplier shall indemnify the Buyer for any and all damages and fines as a result, either direct or indirect, with respect to any
      employment-related
      claims.
      2.8 Cancellation or Suspension of a Contract: Unless otherwise agreed in the Special Terms and Conditions, the Buyer may cancel all or any part of a Contract prior to the
      commencement of its performance by the Supplier; or request the Supplier to suspend performance of a Contract, without the Supplier having any right to claim any compensation
      or indemnity of any kind.
      2.9 Force Majeure: Neither Party shall be in breach of a Contract nor liable to the other for delay in performing or for its failure to perform any of its obligations under a Contract
      where such delay or failure is the result of unforeseen events, circumstances or causes beyond its reasonable control. The Parties agree that the non-performing Party shall:
      (i) Promptly notify the other Party in writing of the occurrence of such event and the way in which its obligations are prevented or impeded by such event, and 
      (ii) Use commercially reasonable efforts to avoid or minimize the delay or failure and to resume performance as soon as reasonably practicable. The time for performance shall be
      extended for a reasonable period having regard to the effects of the cause of the delay or failure to perform, or the Contract shall be cancelled if such cause shall continue for a
      period
      greater than two (2) months.
      2.10 Records, Audit: The Supplier shall maintain complete and accurate records of all matters relating to the Services and/or the Products to demonstrate compliance with its
      obligations under the Contract, including, without limitation, billing, invoices, payment of subcontractors, receipts related to reimbursable expenses and compliance with applicable
      Laws. The Buyer may from time to time audit the Supplier’s premises to verify that it is complying with the Terms and Conditions; such audit will not exclude or limit the Supplier’s
      liability in any way.
      2.11 Remedies: The Supplier shall, at its own cost and expense and in addition to any other remedies available to the Buyer at law or in equity, promptly correct or revise any errors,
      omissions or other deficiencies in the Services and/or Products.
      3. Representations and Warranties, Indemnification and Insurance
      3.1 The Supplier represents and warrants that:
      (A) It has (i) the technical skills, resources and means to ensure the best available quality of the Services and Products; (ii) the financial capacity and human resources to perform
      the
      Contract without risk of interruption or delay; and (iii) all licences, accreditations, rights and approvals necessary, where applicable, to provide the Services and/or to supply the
      Products;
      (B) The execution, delivery and performance of a Contract does not, and will not, conflict with any agreement, instrument or understanding to which it is a party or by which it may
      be bound and there is no action, suit or proceeding before and by any court or governmental authority, pending or, to the Supplier’s knowledge, threatened, which could materially
      affect the Supplier’s performance hereunder or the enforceability hereof;
      (C) Any substances, products, materials or finished articles needed for, or used in, the performance of the Services or the manufacture of the Products shall be introduced into the
      stream of commerce in compliance with all applicable Laws.
      3.2 The Supplier shall indemnify, defend and hold harmless, to the maximum extent permitted by applicable law, the Buyer and its affiliates against all claims, causes of action, suits
      and liabilities, including any damages, fines, interest, penalties, and legal and other professional fees and expenses awarded against or incurred or paid by the Buyer as a result of or
      in connection with any action, omission, inadequacy, negligence, default or mistake attributable to the Supplier, its per sonnel, its subcontractors or its subcontractors’ personnel in
      the performance of a Contract, including, but not limited to, failure to comply with the Terms and Conditions.
      3.3 The Supplier shall maintain in force insurance coverage from a reputable insurance company, insuring against all risks that may arise during the performance and duration of the
      Contract. Such insurance shall include Buyer as additional insured and shall waive right of subrogation against the Buyer. At the Buyer’s request, the Supplier shall provide to the
      Buyer
      proof of payment of its insurance coverage. The Supplier shall be responsible for any payments under its deductible(s) or self-insured retention(s).
      4. Financial conditions
      4.1 Price: The price agreed at the time when a Purchase Order is placed ("Price") is exclusive of any applicable tax, and the Price cannot be revised unless otherwise agreed in
      writing
      by the Parties. The applicable taxes will be added in accordance with the applicable Laws. Unless otherwise agreed in writing by the Parties, the Price includes all performance
      required
      of the Supplier to perfect performance of a Contract and all expenses, charges and disbursements. The Buyer retains the right to request that the Supplier provide a guarantee
      and/or
      to agree to the Buyer partially withholding payment in order to guarantee the performance of a Purchase Order.
      4.2 Invoicing: Unless otherwise agreed in the Special Terms and Conditions, the Price shall be invoiced after full performance of a Purchase Order to the satisfaction of the Buyer.
      The Supplier shall issue an invoice to the Buyer in accordance with all applicable Laws. Where a payment is linked to a particular stage of a Purchase Order, the invoice will be
      subject
      to the completion of that stage, subject to the conditions agreed by the Parties for such invoicing. No supplement to the Price can be invoiced without the Buyer's prior written
      approval. The invoicing currency and address shall be indicated in each Purchase Order.
      4.3 Payment : In the event of non-performance of all or part of a Purchase Order, and without prejudice to any other rights that the Buyer may have under a Contract, the Price will
      be paid to the Supplier pro rata to the Services that have been provided or the Products that have been delivered in accordance with the Terms and Conditions. Alternatively, where
      applicable, the Buyer may request to be immediately reimbursed for any part of the Price already paid to the Supplier. Payment for a correct and undisputed invoice is due sixty (60)
      days upon receipt of the invoice. To the extent permitted by the applicable Laws, late payment interest may only be charged after the Buyer has been formally notified by the
      Supplier.
      The Buyer will pay interest at the statutory rate of interest applicable in India with respect to any amounts not paid when due under a Contract. Without limiting any other rights or
      remedies it may have, to the extent permitted by applicable Laws, the Buyer may offset any amount due by the Buyer to the Supplier against those due by the Supplier to the Buyer.
      For the avoidance of doubt, the Buyer shall not be required to process any invoice or respond to any communication which does not have a Purchase Order number, nor an invoice
      not submitted through Buyer’s accounts payable system.
      4.4 Taxes: In the event any payments made by the Buyer pursuant to a Contract become subject to withholding taxes under the laws or regulation of any jurisdiction, the Buyer shall
      deduct and withhold the amount of such taxes for the account of the Supplier to the extent required by applicable laws or regulations; such amounts payable to the Supplier shall be
      reduced by the amount of taxes deducted and withheld; and the Buyer shall pay the amounts of such taxes to the proper governmental authority in a timely manner and promptly
      transmit to the Supplier an official tax certificate or other evidence of such tax obligations together with proof of payment from the relevant governmental authority of all amounts
      deducted and withheld sufficient to enable the Supplier to claim such payment of taxes. Any such withholding taxes required under applicable laws or regulations to be paid or
      withheld shall be an expense of, and borne solely by, the Supplier. The Buyer will provide the Supplier with reasonable assistance to enable the Supplier to recover such taxes as
      permitted by applicable laws or regulations.
      5. Confidentiality
      5.1 The Supplier shall keep in strict confidence all confidential information of the Buyer (however recorded, preserved or disclosed) of any kind whatsoever relating to information of
      a confidential, proprietary, economic, technical, financial or commercial nature, concerning, inter alia, the Buyer, its activities or the subject of a Contract (“Confidential Information”).
      5.2 The Supplier shall not use any such Confidential Information for any purpose other than to perform its obligations as envisaged by, or under, the Contract.
      5.3 The Supplier may only disclose Confidential Information to its employees, officers or permitted subcontractors to the extent strictly necessary for the performance of a Contract
      and shall ensure that its employees, officers or permitted subcontractors to whom it discloses Confidential Information are subject to obligations of confidentiality and non-use that
      are no less onerous than those contained in these Terms and Conditions and that any use of the Confidential Information is for the sole purpose of performing their obligations in
      accordance with a Contract.
      5.4 Confidential Information shall not include information which the Supplier can evidence by written records that, at the time of disclosure:
      (i) Is already in the public domain, or was legally obtained from other sources which were not under an obligation to the Buyer to maintain confidentiality; or
      (ii) Is already lawfully in possession of the Supplier.
      5.5 Except as otherwise required by any court of relevant jurisdiction or by any regulatory authority or unless it has received the Buyer's prior written approval, the Supplier shall not:
      (i) make any public disclosure or any use of the Confidential Information, or 
      (ii) use the name, trade name, logo or intellectual property of the Buyer, or those of the LPPL group of companies as a trade reference or in any publication of any kind whatsoever,
      without the Buyer’s prior written approval.
      5.6 Upon the Buyer’s request or the termination or expiration of a Contract, the Supplier shall promptly return to the Buyer or destroy all Confidential Information.
      5.7 The provisions of this section 5 will remain in force for a period of five (5) years from the date of termination of the Contract, regardless of the date or cause of this termination.
      6. Intellectual property rights
      6.1 All materials, equipment and tools, drawings, specifications, data supplied by the Buyer to the Supplier (“Pre-existing Materials”) and all rights in the Pre-existing Materials are,
      and shall remain, the exclusive property of the Buyer and must be returned upon the request of the Buyer, or upon completion or termination of a Contract.
      6.2 The Supplier assigns to the Buyer, for India and for all other countries, with full title guarantee and free from all third party rights any Intellectual Property Rights in all documents,
      deliverables, Products and materials to be provided by the Supplier or its employees, officers or permitted subcontractors in relation to the Services in any form, including without
      limitation data, reports and specifications. The cost of the assignment of the above-mentioned rights is included in the Price. The Buyer may thus, without any additional cost but the
      Price, freely use, reproduce or adapt all such documents, deliverables, Products and materials; and the Supplier may under no circumstances subsequently use the said documents,
      deliverables, Products and materials without the Buyer's prior written approval. This assignment is understood to cover all fields (including the Internet) and will remain in force for
      the entire duration of the protection of the Intellectual Property Rights afforded by the legislation relating to Intellectual Property Rights. For purposes of this section, Intellectual
      Property Rights shall mean, without limitation, (a) any patents, invention disclosures, including continuations, divisional, continuation-in-parts, reissues, re-examinations, extensions
      and supplementary protection certificates, and any applications and/or registrations thereof; (b) trademarks, service marks, names, corporate names, trade names, domain names,
      logos, slogans, trade dress, design rights, and other similar designations of source or origin and all applications and/or registrations therefor: (c) copyrights and copyrightable
      subject matter and all applications and/or registrations therefor; and (d) information and know-how, practices, techniques, methods, processes, ideas, concepts, inventions,
      developments, specifications (including Specifications, formulations, structures, trade secrets, analytical and quality control information and procedures, pharmacological,
      toxicological and clinical test data and results, stability data, studies and procedures and regulatory information.
      6.3 The Supplier warrants that it has and shall have full clear and unencumbered title to all Products and deliverables provided to the Buyer, and that at the date of delivery of the
      Products and deliverables to the Buyer, it will have full and unrestricted rights to transfer them to the Buyer.
      6.4 If methods or documents provided as part of the Services and/or Products are the property of the Supplier or third parties to which the Supplier has the right to use and/or
      disseminate, the Supplier shall grant the Buyer a non-exclusive, irrevocable, perpetual licence (or sub-licence) to use those methods or documents in connection with the Services
      and/or Products.
      6.5 In the event that a Contract is terminated, regardless of the reason for such termination, the Supplier undertakes to deliver to the Buyer, within ten (10) calendar days from the
      date of termination of the Contract, all the elements produced in the context of such Contract, without it being necessary for the Buyer to make any request to that end.
      7. Termination
      7.1 Without prejudice to any other rights or remedies which it may have, one Party may terminate a Contract without liability to the other Party immediately on giving notice to the
      other Party:
      (i) if the other Party commits a breach of any of the terms of such Contract and (if such a breach is remediable) fails to remedy that breach within ten (10) working days of being
      notified in writing of the breach;
      (ii) In the event of insolvency of, assignment for the benefit of creditors by, or the initiation of bankruptcy proceedings by or against, the other Party;
      (iii) If a force majeure event lasts for more than two (2) months;
      (iv) If the other Party suspends or ceases, or threatens to suspend or cease, to carry on all or a substantial part of its business; or
      (v) If the Buyer learns that improper payments to third parties are being, or have been, made by the Supplier. The termination of a Contract shall not affect the Parties rights to
      claim any damages they may be entitled to seek.
      7.2 Early termination of a Contract, for any reason, whether by the Buyer or the Supplier, shall not affect any other Purchase
      Orders placed by the Buyer with the Supplier or any other Contracts in place.
      8. Governing law
      The construction, validity, and performance of all Purchase Orders and Contracts shall be governed by the Laws of India (unless otherwise agreed in the Special Terms and
      Conditions)
      and in the event that any dispute or claim arising therefrom cannot be resolved out of court by the Parties, such claim or dispute shall be subject to the exclusive jurisdiction of the
      courts of India, even in the case of summary proceedings, third party claims, or if there is more than one defendant.
      9. General
      9.1 The complete or partial invalidity or unenforceability of any provision hereof shall in no way affect the validity or enforceability of such provision for any other purpose or the
      remaining provisions hereof.
      9.2 A Purchase Order or Contract and/or any part thereof shall not be wholly or partially assigned by the Supplier without the Buyer's prior written approval. If the Supplier assigns a
      Purchase Order or Contract and/or any part thereof without the Buyer's consent, the Supplier shall remain personally liable towards the Buyer and third parties. The Buyer may
      assign
      a Purchase Order or Contract or any part thereof to any person, firm or company.
      9.3 No admission, act or omission made by either Party during the continuance of a Contract shall constitute a waiver of, or release of the other Party from, any liability under any
      Contract.
      9.4 The Parties agree that nothing in a Purchase Order or Contract creates any obligation on the Buyer to place any future order with the Supplier. Furthermore, nothing in a
      Purchase
      Order or Contract is intended, or shall be deemed, to establish any partnership or joint venture between the Parties, render any Party the agent of the other Party, or authorise a
      party
      to make or enter into any commitments for, or on behalf of, the other Party.
      9.5 No waiver of any provision of a Contract shall constitute a waiver of any other breach of such provision or the breach of any other provision.
      9.6 A person who is not a party to the Terms and Conditions shall not have any rights under or in connection with them.
      9.7 LPL shall release the GST charges payment as per prevailing rates on its reflection of GST Portal after return filling (GSTR2A) by the supplier or service provider. Or getting the
      Input tax credit against the submitted invoices
      `,
      warranty: '12 months or 1000 hrs from commissioning whichever earlier',
      delivery: '3 WEEKS FROM PO DATE',
      // otherExpenses: [
      //   { title: 'TCS(1%)', amount: 51485.15 },
      //   { title: 'Registration & Insurance', amount: 441944.0 }
      // ]
    };

    // If the request provided data, shallow-merge it (keeps placeholders when request misses fields)
    if (poData && Object.keys(poData).length) {
      Object.assign(data, poData);
    }

    if(data.company.logoUrl) {
      data.company.logoUrlBase64 = await getBase64FromUrl(data.company.logoUrl)
    }

    if (data.created_at) {
      const createdInDate = new Date(data.created_at);
      // Pad single digits with zero for day and month
      const day = String(createdInDate.getDate()).padStart(2, '0');
      const month = String(createdInDate.getMonth() + 1).padStart(2, '0'); // Months are zero-based
      const year = createdInDate.getFullYear();
      data.created_at = `${day}/${month}/${year}`;
    }

    if (data.timestamp) {
      const createdInDate = new Date(data.timestamp);
      // Pad single digits with zero for day and month
      const day = String(createdInDate.getDate()).padStart(2, '0');
      const month = String(createdInDate.getMonth() + 1).padStart(2, '0'); // Months are zero-based
      const year = createdInDate.getFullYear();
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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
