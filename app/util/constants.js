export const AVAILABLE_HIERARCHY_TYPES = {
  finalization: {
    type: 'finalization',
    target_entity_type: 'rfq_product'
  },
  po: {
    type: 'po',
    target_entity_type: 'purchase_order'
  }
};

export const APPROVAL_DECISIONS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
}

export const PO_STATUSES = {
  DRAFT: 'draft', 
  PENDING_APPROVAL: 'pending_approval', 
  APPROVED: 'approved', 
  SENT: 'sent', 
  GRN: 'GRN', 
  COMPLETED: 'completed', 
  CANCELLED: 'cancelled',
  REJECTED: 'rejected'
}

// For Now Hard Coded Tender Summaries
export const summaries = [
  {
    file_name: 'gmpl_composite_works',
    markup: `
      <div>
      <h2 class="mb-3 text-primary">Tender Summary - GMPL Composite Works</h2>

      <!-- Tender Basic Details -->
      <h4 class="mt-4 text-secondary">1. Tender Title, Owner, Location, Tender Type</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th scope="row" style="width: 25%;">Title</th>
                  <td>Composite Works for Completion of Balance Jobs on Single Point Responsibility Basis at GMPL</td>
              </tr>
              <tr>
                  <th scope="row">Owner</th>
                  <td>GAIL Mangalore Petrochemicals Limited (GMPL), wholly owned subsidiary of GAIL (India) Limited</td>
              </tr>
              <tr>
                  <th scope="row">Location</th>
                  <td>GMPL, Village Bajpe, Mangalore SEZ Ltd., Karnataka - 574142</td>
              </tr>
              <tr>
                  <th scope="row">Tender Type</th>
                  <td>Two-Bid System (Techno-Commercial + Price Bids) under Open Domestic Competitive Bidding via e-Tender</td>
              </tr>
          </tbody>
      </table>

      <!-- Scope of Work -->
      <h4 class="mt-4 text-secondary">2. Scope of Work</h4>
      <ul>
          <li>Completion of all remaining “balance” jobs at GMPL plant under single-point responsibility.</li>
          <li>Includes mechanical, electrical, instrumentation, piping, structural, civil, insulation, and associated tasks necessary for commissioning and handover.</li>
          <li>Contractor to provide all labour, supervision, tools, tackles, machinery, materials, consumables, and services.</li>
          <li>Ensure compliance with statutory and safety requirements, quality assurance standards, and coordination with GMPL project teams.</li>
          <li>Seamless integration with existing plant systems with minimal operational disruption.</li>
      </ul>

      <!-- Commercial Details -->
      <h4 class="mt-4 text-secondary">3. Estimated Tender Value, EMD, Tender Fees</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th>Estimated Tender Value</th>
                  <td>Not explicitly stated. Refer to BDS/Price Schedule for confirmation.</td>
              </tr>
              <tr>
                  <th>EMD</th>
                  <td>₹94.18 Lakhs (mandatory for all, exemptions for Start-Ups & CPSEs with declaration per Form F-2A).</td>
              </tr>
              <tr>
                  <th>Tender Fees</th>
                  <td>Not mentioned; downloadable free from portals.</td>
              </tr>
          </tbody>
      </table>

      <!-- Eligibility -->
      <h4 class="mt-4 text-secondary">4. Eligibility / Bid Qualification Criteria (BQC)</h4>
      <ul>
          <li>Proven execution of similar composite works in petrochemical, refinery, or chemical plants.</li>
          <li>Meets project value and turnover requirements as per ITB Clause 9.</li>
          <li>Availability of qualified engineers, supervisors, and safety personnel.</li>
          <li>Compliance with statutory registrations (GST, PAN, labour laws, ESI/EPF).</li>
          <li>No blacklisting or holiday listing by any PSU/Government body.</li>
      </ul>

      <!-- Key Dates -->
      <h4 class="mt-4 text-secondary">5. Key Dates</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th>Publication Date</th>
                  <td>25.03.2025</td>
              </tr>
              <tr>
                  <th>Pre-Bid Meeting</th>
                  <td>01.04.2025, 11:00 hrs (via Microsoft Teams)</td>
              </tr>
              <tr>
                  <th>Bid Submission Deadline</th>
                  <td>09.04.2025, 15:00 hrs</td>
              </tr>
              <tr>
                  <th>Un-Priced Bid Opening</th>
                  <td>10.04.2025, 15:00 hrs</td>
              </tr>
              <tr>
                  <th>Price Bid Opening</th>
                  <td>To be intimated to techno-commercially qualified bidders.</td>
              </tr>
          </tbody>
      </table>

      <!-- Completion Period -->
      <h4 class="mt-4 text-secondary">6. Completion Period / Deliverables</h4>
      <ul>
          <li>Duration as per bidding document (likely several months; exact in SCC/Annexures).</li>
          <li>Fully completed works, tested systems, commissioning, documentation, warranties, and defect liability support.</li>
      </ul>

      <!-- Highlights -->
      <h4 class="mt-4 text-secondary">7. Notable Technical / Commercial Highlights</h4>
      <ul>
          <li><strong>Single Point Responsibility:</strong> Contractor accountable for overall package.</li>
          <li>Strict safety & quality compliance as per GMPL standards.</li>
          <li>E-Tender submission via <em>etenders.gov.in</em>, with physical submission of key documents within 7 days of bid due date.</li>
          <li>Large EMD indicates high-value and financially intense contract.</li>
      </ul>

      <!-- Risks & Opportunities -->
      <h5 class="mt-4">Project Risks</h5>
      <ul>
          <li>Interface with existing facilities could cause delays.</li>
          <li>Supply chain issues for specialized materials/equipment.</li>
          <li>Challenges in integrating civil, mechanical, and E&I works.</li>
          <li>Tight timelines for bidding and execution impacting mobilization.</li>
      </ul>

      <h5 class="mt-4">Key Opportunity Areas</h5>
      <ul>
          <li>Potential long-term relationship with GMPL/GAIL.</li>
          <li>Possibility of variation orders for additional works.</li>
          <li>Strengthens credentials in composite EPC projects.</li>
      </ul>

      <!-- Vendor Strengths -->
      <h4 class="mt-4 text-secondary">Vendor Qualification Highlights</h4>
      <ul>
          <li>Strong multi-disciplinary execution capabilities.</li>
          <li>Financial strength to manage high EMD and cash flows.</li>
          <li>Robust safety and QA/QC track record.</li>
          <li>Experienced workforce and PSU project experience.</li>
      </ul>
  </div>
    `
  },
  {
    file_name: 'mrpl_depot_automation_works',
    markup: `
      <div>
      <h2 class="mb-3 text-primary">Tender Summary - MRPL Depot Automation Works</h2>

      <!-- Tender Basic Details -->
      <h4 class="mt-4 text-secondary">1. Tender Title, Owner, Location, Tender Type</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th scope="row" style="width: 25%;">Title</th>
                  <td>Depot Automation Package on Composite Works for MRPL Kasaragod and Hosur Depot</td>
              </tr>
              <tr>
                  <th scope="row">Owner</th>
                  <td>Mangalore Refinery & Petrochemicals Ltd. (MRPL), a subsidiary of Oil & Natural Gas Corporation Ltd. (ONGC)</td>
              </tr>
              <tr>
                  <th scope="row">Location</th>
                  <td>
                      <strong>MRPL Petroleum Oil Depot, Kasaragod:</strong> Plot No. 15 to 19, KINFRA Small Industries Park, Seethangoli, Maipady P.O., Kasaragod - 671124, Kerala<br>
                      <strong>MRPL Depot, Hosur:</strong> E.11, SIPCOT Phase 2 Expansion 1, Moranapalli, Hosur - 635109, Tamil Nadu
                  </td>
              </tr>
              <tr>
                  <th scope="row">Tender Type</th>
                  <td>E-Open, Two-Bid System (Techno-Commercial + Price Bid) via EPS e-Tender</td>
              </tr>
          </tbody>
      </table>

      <!-- Scope of Work -->
      <h4 class="mt-4 text-secondary">2. Scope of Work</h4>
      <ul>
          <li>Design, engineering, supply, installation, integration, testing, and commissioning of depot automation systems at MRPL Kasaragod and Hosur depots.</li>
          <li>New top loading arms and bottom loading facilities for MS and HSD.</li>
          <li>Piping modifications for mixed loading from both bays.</li>
          <li>Supply and installation of metering instruments, valves, strainers, RTDs, batch controllers, and associated systems.</li>
          <li>PLC-based control with ESD logic, gas detection systems, earthing, instrumentation, cabling, and integration with depot automation software.</li>
          <li>Structural and civil works, dismantling of existing systems, and installation of new equipment.</li>
          <li>Calibration, testing, commissioning, and statutory compliance including liaison with Legal Metrology.</li>
      </ul>

      <!-- Commercial Details -->
      <h4 class="mt-4 text-secondary">3. Estimated Tender Value, EMD, Tender Fees</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th>Estimated Tender Value</th>
                  <td>₹3,20,51,210 (as per Schedule of Rates total)</td>
              </tr>
              <tr>
                  <th>EMD</th>
                  <td>₹6,42,000/- (payable via NEFT, BG, DD, or Insurance Surety Bond in favour of MRPL)</td>
              </tr>
              <tr>
                  <th>Tender Fees</th>
                  <td>Not applicable (documents downloadable free from portal)</td>
              </tr>
          </tbody>
      </table>

      <!-- Eligibility -->
      <h4 class="mt-4 text-secondary">4. Eligibility / Bid Qualification Criteria (PQC)</h4>
      <ul>
          <li><strong>Financial Turnover:</strong> Average annual turnover in the last 3 years ≥ ₹96 Lakhs.</li>
          <li><strong>Past Experience:</strong> Similar works in the last 7 years:
              <ul>
                  <li>3 works ≥ ₹128 Lakhs each, OR</li>
                  <li>2 works ≥ ₹160 Lakhs each, OR</li>
                  <li>1 work ≥ ₹256 Lakhs.</li>
              </ul>
          </li>
          <li>Similar works include Terminal Automation System (TAS) for petroleum/petrochemical depots including mechanical, electrical, civil, TFMS, CCTV, leak detection, metering skid, and fire alarm.</li>
          <li>Must bid for all BOQ items.</li>
          <li>No JV/consortium participation allowed.</li>
          <li>No blacklisting/holiday listing by MRPL/MoPNG/DoE.</li>
      </ul>

      <!-- Key Dates -->
      <h4 class="mt-4 text-secondary">5. Key Dates</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th>Tender Download Start</th>
                  <td>05.05.2025</td>
              </tr>
              <tr>
                  <th>Tender Download End</th>
                  <td>04.06.2025, 15:00 hrs</td>
              </tr>
              <tr>
                  <th>Pre-Bid Meeting</th>
                  <td>17.05.2025, 11:00 hrs (via video conference)</td>
              </tr>
              <tr>
                  <th>Bid Submission Deadline</th>
                  <td>04.06.2025, 15:00 hrs</td>
              </tr>
              <tr>
                  <th>Unpriced Bid Opening</th>
                  <td>04.06.2025, 15:30 hrs</td>
              </tr>
          </tbody>
      </table>

      <!-- Completion Period -->
      <h4 class="mt-4 text-secondary">6. Completion Period / Deliverables</h4>
      <ul>
          <li><strong>Mechanical Completion:</strong> 10 months from LOA/PO.</li>
          <li><strong>Commissioning Completion:</strong> 1 month from mechanical completion.</li>
          <li><strong>Final Commercial Closure:</strong> 3 months from mechanical completion.</li>
          <li>Deliverables include fully functional and commissioned depot automation system with statutory clearances, documentation, warranties, and 12-month defect liability support post-commissioning.</li>
      </ul>

      <!-- Highlights -->
      <h4 class="mt-4 text-secondary">7. Notable Technical / Commercial Highlights</h4>
      <ul>
          <li>Single composite contract covering two depots.</li>
          <li>Scope includes mechanical, electrical, instrumentation, piping, structural, and civil works in one package.</li>
          <li>Defect Liability: 12 months from commissioning; Security Deposit: 10% of basic order value.</li>
          <li>Price Reduction Clause applicable.</li>
          <li>Integrity Pact applicable.</li>
          <li>Payment terms: Progressive payments as per certified milestones; payments released within 15 days of invoice submission.</li>
          <li>Mandatory compliance with MRPL Contractor Worker Safety Policy.</li>
      </ul>

      <!-- Risks & Opportunities -->
      <h5 class="mt-4">Project Risks</h5>
      <ul>
          <li>Coordination of works at two geographically separate depots.</li>
          <li>Integration challenges with existing depot infrastructure.</li>
          <li>Statutory approvals and liaison challenges with Legal Metrology.</li>
          <li>Tight execution schedule.</li>
      </ul>

      <h5 class="mt-4">Key Opportunity Areas</h5>
      <ul>
          <li>Possibility for follow-up works in MRPL depot automation/expansion projects.</li>
          <li>Strengthened credentials in composite petroleum depot EPC works.</li>
      </ul>

      <!-- Vendor Strengths -->
      <h4 class="mt-4 text-secondary">Vendor Qualification Highlights</h4>
      <ul>
          <li>Proven multi-disciplinary execution in petroleum depot automation.</li>
          <li>Strong financial capacity to meet EMD and execute within schedule.</li>
          <li>Compliance with MRPL safety, statutory, and quality standards.</li>
      </ul>
  </div>
    `
  },
  {
    file_name: 'iocl',
    markup: `
      <div> <h1>Executive Tender Summary — IOCL Guwahati (CRU Project)</h1> <h2>Overview</h2> <p><strong>Project Title:</strong> Mechanical, Piping &amp; Insulation Works (Part A &amp; Part B) for Catalytic Reforming Unit (CRU) Project at IOCL Guwahati Refinery, Noonmati, Guwahati, Assam.</p> <p><strong>Tender No.:</strong> 213102-00123 </p> <p><strong>Client / Owner:</strong> Indian Oil Corporation Limited (Refineries Division). <strong>Consultant / Issuing Agency:</strong> Worley Services India Private Limited (EPCM). </p> <p><strong>Location:</strong> Guwahati Refinery, Noonmati, Guwahati, Assam, India. </p> <p><strong>Type of Bidding Process:</strong> Open — Domestic Competitive Bidding (E-bidding). Single-stage, two-bid system with online Reverse Auction. </p> <p><strong>Tender document length / parts (index):</strong> The bid document is split into three parts — Part I (Commercial), Part II (Price), Part III (Technical). The master index lists numerous annexures and technical specification documents (see Technical Part index). (Master index &amp; part listing). </p> <h2>Key Dates — Download / Submission / Pre-bid</h2> <ul> <li><strong>Tender download period:</strong> 09-05-2025 to 23-05-2025 (up to 1600 hours). </li> <li><strong>Start of bid submission (portal):</strong> From 16:00 Hrs on 20-05-2025.</li> <li><strong>Last date for bid submission (portal):</strong> Up to 16:00 Hrs on 23-05-2025.</li> <li><strong>Techno-commercial (unpriced) opening:</strong> 16:00 Hrs on 26-05-2025 (subject to next working day rule if holiday).</li> <li><strong>Pre-bid meeting:</strong> 11:00 Hrs on 15-05-2025 at the Refinery site. Last date for submitting pre-bid queries: 14-05-2025. Contact persons and emails are provided in the NIT. </li> </ul> <h2>1. Scope of Work (brief / as stated)</h2> <p>The tender sets out that the <em>bidder will be single-point responsible contractor</em> for the entire mechanical, piping &amp; insulation scope for the CRU project. The scope (non-exhaustive, full detail in technical schedules and SOR) includes:</p> <ul> <li>Piping fabrication and erection including painting and insulation and associated works. </li> <li>Erection / installation of equipment. </li> <li>Works are further defined in the Schedule of Rates, technical specifications, drawings and all annexures listed in the Master Index (detailed piping specs, valves specs, painting, insulation specs, bolt tightening, piping supports, equipment erection &amp; piping fabrication standards etc.). </li> </ul> <p><em>Note:</em> The tender repeatedly points bidders to the detailed Technical Part (Part III) and the annexures for full scope and standards — the brief above is drawn only from the NIT summary; bidders must study the technical specs and SOR for item-level scope. </p> <h2>2. Major Facilities / Structures</h2> <p>The master index and drawings list indicates overall plot plan, equipment layouts and detailed line lists and equipment lists for insulation and piping — these support CRU feed pump areas and overall CRU equipment layout. The tender DOES NOT present a short plain-language list of every new building; bidders should consult the drawings listed in the Technical Part for the full list of new/retrofitted structures and equipment layouts. </p> <h2>3. Bidder Qualification Criteria (BQC)</h2> <p><strong>General:</strong> Intending bidders must meet minimum qualification criteria specified in Part-I (techno-commercial) and furnish proof / supporting documents. Bidders who received NOAs against tender 213102-00123-C-017 are explicitly ineligible.</p> <p><strong>Commercial experience criteria (examples from NIT):</strong></p> <ul> <li>One similar completed work costing ≥ INR 3,08,37,000 (Rs. 3.0837 Crore), OR</li> <li>Two similar completed works each costing ≥ INR 2,31,28,000, OR</li> <li>Three similar completed works each costing ≥ INR 1,54,19,000. </li> </ul> <p><strong>Definition of “similar” work:</strong> Mechanical works involving equipment erection and carbon steel / alloy / stainless steel piping works in refinery / petrochemical / fertilizer / oil &amp; gas / hydrocarbon industry. Supply of pipes &amp; equipment alone does not qualify as mechanical erection experience. </p> <p><strong>Documents accepted as proof:</strong> Purchase / work order copy with schedule of rates / scope of works and related completion documents as defined in the BQC clauses. (See detailed BQC text in Part I). </p> <p><strong>Other BQC elements (refer to Part-I):</strong> The tender contains typical requirements for key personnel, mobilization of minimum equipment, deployment of key construction manpower, and penalties for non-performance (annexures listed in the Master Index). Bidders must submit specified annexures and formats. </p> <h2>4. Commercial &amp; Contractual Conditions</h2> <ul> <li><strong>EMD / Bid Security:</strong> Earnest Money Deposit is INR 1,93,000. Tenderers eligible for exemption (Govt orgs, CPSEs, MSEs, etc.) must select the portal exemption option and upload valid documentary proof; original EMD instruments (BG/RTGS/NEFT) are to be submitted in hard copy to Worley (Mumbai address) before unpriced bid opening. </li> <li><strong>Time for completion:</strong> 06 (six) months — Mechanical Completion + 02 (two) months commissioning assistance from date of issue of Notice of Award (NOA). </li> <li><strong>Payment terms:</strong> Refer Special Conditions of Contract (SCC) Part B Annexure-I (terms of payment listed in commercial annexure). Bidders must consult SCC / Annexure B-I for detailed payment schedule and PV (price variation) provisions. </li> <li><strong>General &amp; Special Conditions:</strong> The document includes General Conditions of Contract (GCC), Special Conditions (SCC Part A – Technical and Part B – Commercial) and numerous annexures covering QA/QC, HSE, PPE, safety management and special mobilization and monsoon provisions. (See Master Index for list &amp; page counts). </li> <li><strong>Penalties &amp; performance:</strong> The tender contains penalties for non-performance, mobilization shortfalls and key personnel non-deployment (refer Annexure A-XIV and SCC). Bidders should review the penalty formats and BG (Composite BG) requirements in annexures.</li> </ul> <h2>5. Technical Conditions</h2> <p>The Technical Part (Part III) is extensive — the Master Index lists technical specifications and standards including:</p> <ul> <li>Piping Material Specification; Valves Material Specification; Painting &amp; Insulation specifications; Bolt tightening standard; Piping support standard; Equipment erection, fabrication &amp; erection specification; cleaning, testing &amp; inspection procedures; line lists and equipment &amp; insulation lists; drawings and layouts. (Many documents — see Master Index with page counts). </li> <li><strong>Standards / QA:</strong> The tender references construction quality management &amp; quality control requirements, QA check sheets / CC forms and detailed HSE management specifications (multiple HSE annexures with many pages).</li> </ul> <p><em>Action for bidders:</em> Study Part III documents (listed in Master Index) for material specs, test &amp; inspection protocols, painting &amp; insulation details, and the line list for insulation/equipment lists before preparing technical offers. </p> <h2>6. Tendering Process (submission &amp; evaluation)</h2> <ul> <li><strong>Mode of Submission:</strong> Electronic submission only via IOCL e-tender portal (https://iocletenders.nic.in) using valid DSC (digital signature certificate). Hard copies of original EMD instrument are required to be sent physically to Worley Mumbai address before unpriced bid opening.</li> <li><strong>Bid structure:</strong> Single-stage, two-bid system — Techno-commercial (unpriced) + Price (BOQ) with Reverse Auction to follow for qualified bidders.</li> <li><strong>Opening of bids:</strong> Techno-commercial opening is scheduled (see dates). Priced bid opening is done only for techno-commercially acceptable bidders; RA dates communicated subsequently.</li> <li><strong>Clarifications &amp; Amendments:</strong> The document provides process for clarifications, pre-bid queries (deadlines), and amendment procedures through addenda/corrigenda published on the portal. </li> <li><strong>Reverse Auction specifics:</strong> The RA process and guidelines are included (Annexure-II) — current price, decrement price mechanics, auto-extension rules, and portal procedures are explained in the RA annexure. Bidders must follow portal RA rules. </li> </ul> <h2>7. Mandatory Annexures &amp; Forms</h2> <p>The tender includes a long list of mandatory annexures and submission forms (see Part-I index). Key mandatory items called out in the Master Index and ITB include:</p> <ul> <li>Integrity Pact (included/referenced). </li> <li>Acknowledgement-cum-consent letter / acknowledgement forms. </li> <li>Proposal forms, HSE data forms, Technical compliance confirmations, vendor list format, mobilization &amp; manpower deployment formats, calibration requirements, monsoon precautions, composite BG format, key personnel qualification &amp; penalty formats, sub-contractor approval formats, and numerous QA/QC &amp; HSE annexures. </li> <li>Formats for bidder’s information, affidavits/undertakings and declarations appear across the commercial forms section — bidders must supply them exactly as per formats. </li> </ul> <h2>8. Drawings, SOR &amp; Price Schedules</h2> <p>The Master Index (Part III) lists detailed technical specifications, line lists, equipment lists and multiple drawings: overall plot plan, equipment layouts, CRU feed pump area layout and many detailed drawings. The Price Part (Part II) contains BOQ/Price schedules (priced / unpriced parts) and the SOR references in the annexures — bidders should download and price the BOQ as per the Price Part. </p> <h2>9. Key Takeaways &amp; Risks for Bidders</h2> <ul> <li><strong>Strict schedule &amp; online portal compliance:</strong> Bids must be submitted on the IOCL portal within the stated deadlines; missing EMD instrument originals prior to unpriced bid opening may risk disqualification.</li> <li><strong>Single point contractor responsibility:</strong> The awarded contractor will be single-point responsible for the entire mechanical/piping/insulation scope — ensure capability for composite works and resources. </li> <li><strong>Reverse Auction &amp; price evaluation:</strong> Price evaluation will reflect RA outcome — bidders should prepare for RA mechanics and keep required margins. Foreign bidders must note RA occurs in INR with conversion rules described. </li> <li><strong>Extensive technical annexures:</strong> The technical part is extensive (many specification documents). Non-compliance with specification / QA / HSE annexures can render bids non-responsive. </li> <li><strong>BQC thresholds:</strong> Monetary experience thresholds are significant (single similar work ≥ ~INR 3.08 Cr.) — check past order values and composite work credit rules before bidding. </li> </ul> <h2>10. Final Executive Narrative (1–2 page management summary)</h2> <p><strong>Purpose &amp; scope:</strong> Indian Oil (IOCL) through Worley invites bids for mechanical, piping and insulation works for the new Catalytic Reforming Unit at Guwahati Refinery (Tender No. 213102-00123-C-020). The contractor will undertake piping fabrication &amp; erection (CS/AS/SS), equipment erection, painting and insulation and will be single-point responsible for the scope. The full technical scope and itemised requirements reside in Part III (technical specifications, line lists and drawings) and must be reviewed in detail before pricing/commitment. </p> <p><strong>Commercial structure &amp; schedule:</strong> This is an open domestic e-bid (single-stage two-bid) with an online reverse auction to follow. Mechanical completion is scheduled for six months from NOA, plus two months commissioning assistance. Bids are to be submitted on the IOCL e-tender portal; key dates include download window (09-05-2025 to 23-05-2025), portal submission (20-05-2025 to 23-05-2025), and techno-commercial opening on 26-05-2025. EMD of INR 1,93,000 is required (portal exemption allowed for eligible entities with documentary proof; original instrument submission required). </p> <p><strong>Qualification &amp; risk considerations:</strong> Bidders must meet defined experience thresholds (examples: single similar work ≥ INR 3.08 Cr or two/three works with stated values) and demonstrate mechanical &amp; piping erection experience in hydrocarbon industries. Major risks for bidders include: inadequate documentary proof for BQC, failure to comply with extensive technical/HSE/QA requirements, not meeting minimum equipment / manpower mobilization formats, and being unprepared for the reverse auction price dynamics. The RA and portal rules (Annexure-II) must be understood and practiced. </p>
        </div>
    `
  },
  {
    file_name: 'HPCL_MUMBAI',
    markup: `
    <div> <h1>Tender Summary — HEATER PACKAGE (NEW + REVAMP) — MREP, HPCL Mumbai</h1> <h2>Document metadata (Overview)</h2>

    <ul> <li><strong>Project name:</strong> HEATER PACKAGE (NEW + REVAMP) of “MREP” — Mumbai Refinery Expansion Project (MREP). </li> <li><strong>Bidding document no.:</strong> CK/A945-000-MC-TN-7601/1002.</li> <li><strong>Client / Employer:</strong> Hindustan Petroleum Corporation Limited (HPCL), Mumbai Refinery.</li> <li><strong>PMC / Issuing Authority:</strong> Engineers India Ltd. (EIL) on behalf of HPCL. </li> <li><strong>Location:</strong> HPCL Mumbai Refinery, B. D. Patil Marg, Mahul, Mumbai – 400074, Maharashtra, India.</li> <li><strong>Procurement type / Bid system:</strong> Domestic competitive bidding — single-stage, two-part system (Part-I: Techno-commercial; Part-II: Price).</li> <li><strong>Total document length:</strong> 2,543 pages (master index / page headers indicate a 2543-page bidding document).</li> </ul>


    <h2>1. Scope of Work (concise, extracted points)</h2> <p>Summary of full-scope activities required of the Contractor (as stated in the tender):</p> <ul> <li>Project management, residual design &amp; detailed engineering including preparation of fabrication drawings and vendor documents.</li> <li>Procurement &amp; supply of heater system components and auxiliaries (supply portion).</li> <li>Shop fabrication (including modularization where applicable), site construction &amp; erection, inspection and construction supervision/QA.</li> <li>Pre-commissioning, commissioning assistance and two-year O&amp;M spares (as specified in Schedule of Prices). </li> <li>All civil, structural, mechanical, piping, electrical, instrumentation, refractory, insulation, painting and related activities necessary to make heaters functional. </li> <li>Dismantling and modification works for existing heaters where revamp is required; depositing salvage/material as instructed within refinery premises. </li> <li>Supply of specific items listed (e.g., heater shells, finned &amp; studded tubes, tube supports, fans, burners, expansion bellows, dampers, thermocouples, refractories, painting, etc.)</li> </ul> <h2>2. Major Facilities / Structures (new &amp; revamp items called out)</h2> <p>Units / heater items explicitly referenced (representative list from technical index and scope):</p> <ul> <li>VPS — New Vacuum Heater 24-F-1001 (VPS item)</li> <li>PRIME-G+ — New heater 105-F-5001 (PrimeG+)</li> <li>Multiple existing heaters earmarked for modification/revamp such as Crude Heaters 11-F-1(M) and 11-F-2(M), NHT/CCR charge heater items and others listed in the technical index. </li> <li>Detailed equipment layouts and drawings provided for VPS, NHT CCR, PRIME G+, HDT, etc., in Technical Part and drawings listing.</li> </ul> <h2>3. Bidder Qualification Criteria (BQC) — key extracts</h2> <ul> <li><strong>Eligible bidder types:</strong> Sole bidder; incorporated joint venture; consortium (maximum 2 members) — prime member / leader concept applies. Conditions for consortium composition, stake minimum (no member &lt;25%), joint &amp; several liability, and power of attorney to lead member are specified</li> <li><strong>Experience evidence:</strong> Experience record proforma and requirement to submit reference heater/reformer/cracker projects (duty, tag nos., scope, contract value, client contact data)</li> <li><strong>Financial criteria:</strong> Audited financial statements for preceding three financial years required; net worth positivity for consortium members; working capital / turnover proofs as per BQC (see Annexures / Forms)</li> <li><strong>Documentation:</strong> Audited reports, profit &amp; loss accounts, schedules, Power of Attorney, signed Integrity Pact (if applicable), MOU for consortium, and other documentary proofs as per clauses. Original documents (where required) must be submitted to EIL address. </li> <li><strong>Restrictions:</strong> Blacklisting/false documentation/fraud provisions; declarations and affidavit formats provided; bidders found submitting forged documents face forfeiture/blacklisting</li> </ul> <h2>4. Commercial &amp; Contractual Conditions — salient clauses</h2> <ul> <li><strong>EMD / Bid Security:</strong> EMD must be uploaded scanned on e-procurement website and original EMD (or BG in lieu) submitted to PMC EIL address by bid due date/time. BG validity typically 6 months from due date (revalidation required for extensions). Exemptions for MSMEs and certain PSUs are detailed (documentary proof required). </li> <li><strong>Forfeiture &amp; return:</strong> EMD forfeited for revocation/withdrawal/forgery or failure to sign contract/provide performance BG. EMD of unsuccessful bidders returned after award; successful bidder’s EMD returned after submission of Security Deposit/PBG. </li> <li><strong>Prices &amp; Price bid:</strong> Lumpsum turnkey (LSTK) pricing; Bidder to quote total lump sum in FORM SP-0 with breakups SP-1 (engineering), SP-2 (supply), SP-3 (construction). Prices are firm unless otherwise provided. Forms and breakdowns are in Schedule of Prices. </li> <li><strong>Time for completion:</strong> Overall completion within 20 months from issue of LOA; mechanical completion of VPS heater (24-F-1001) within 16 months; Prime-G+ heater mechanical completion within 12 months; assistance in commissioning/shutdown windows (30 calendar days for certain items). Detailed time table appears in SCC/Annexures</li> <li><strong>Payment &amp; penalties:</strong> Payment terms, retention money, CPBG (composite performance bank guarantee), defect liability/guarantee period and penalties for slippage are governed by GTC &amp; SCC (refer to those sections). Bid non-compliance on these is a cause for rejection. </li> </ul> <h2>5. Technical Conditions &amp; Standards</h2> <ul> <li><strong>Technical specifications:</strong> Job specifications for fired heater package, specifications for procured parts (castings, sootblowers, dampers, insulation, expansion joints, refractory modifications, modularization, etc.) are included in Technical Part (numerous spec documents referenced). </li> <li><strong>Standards &amp; codes:</strong> Engineering design basis and standard specification documents are included (e.g., piping material specs, valve material specs, instrument ITPs, PLC specs, thermocouple specs). Contractors must follow referenced standards in the technical volumes. </li> <li><strong>Quality &amp; document control:</strong> Vendor Data Requirements (VDR), vendor data formats, documentation requirements, document review codes (R, V, R3 etc.), Document Control Index (DCI) submission requirements, and eDMS upload procedures are specified</li> <li><strong>Inspection &amp; testing:</strong> ITPs (inspection &amp; test plans) for PLCs, thermocouples, local control panels and other items are referenced in the technical index; inspection regimes will follow the ITPs and SCC/GTC. </li> </ul> <h2>6. Tendering Process &amp; Important Timelines</h2> <ul> <li><strong>Availability &amp; where to view:</strong> Complete bidding document and NIT placed on Government e-procurement portal (https://eprocure.gov.in/eprocure/app). Amendments/addenda will be uploaded only on the portal</li> <li><strong>Bid submission system:</strong> E-bids via the Central Public Procurement (CPP) portal — with requirement to upload scanned documents and also deliver specified original physical documents (e.g., original EMD, Integrity Pact, Power of Attorney) to the EIL address by bid due date/time</li> <li><strong>Bid opening:</strong> Document specifies un-priced (techno-commercial) bid opening date/time on CPP portal; price bids opened only after techno-commercial evaluation/qualification. (See NIT and ITB sections for exact dates and practice). </li> <li><strong>Pre-bid and clarifications:</strong> Clarification procedure and amendment mechanism laid out — bidders must watch the e-procure site; clarifications not requested by EIL may be ignored; failure to reply to EIL clarifications may lead to bid evaluation based on available info. </li> <li><strong>Deadlines &amp; strict compliance:</strong> Deadlines for e-bid submission and for receipt of originals are strictly enforced; non-compliance can make bids liable for rejection. </li> </ul> <h2>7. Mandatory Annexures &amp; Forms</h2> <ul> <li>Integrity Pact (signed on each page) — original to be submitted where specified</li> <li>Power of Attorney of bid signatory; MOU for consortium where applicable; affidavits/declarations (false document declaration). </li> <li>Experience Record Proforma (Annexure-II) for reference heaters / projects (to support BQC)</li> <li>Forms for price schedule (SP-0 to SP-10) and other prescribed formats (ITB / Annexures)</li> </ul> <h2>8. Drawings, Schedule of Rates (SOR) &amp; Price Schedules</h2> <ul> <li><strong>Schedule of Prices (SOR):</strong> Detailed SOP / Schedules provided (Index to Schedule of Prices, forms SP-0 to SP-10, preamble and itemised breakup including supply/installation/O&amp;M spares)</li> <li><strong>Technical Drawings &amp; Datasheets:</strong> A large set of equipment layout drawings, GA drawings and item-specific drawings (list in the technical index and drawing register). Numerous document numbers and drawing references are provided in the Master Index / Technical Part. </li> <li><strong>Priced / Un-priced parts:</strong> The document prescribes the un-priced e-bid submission (techno-commercial) and the separate price part (Form SP-0 etc.). SOR includes both lump sum (SP-0) and detailed breakups (SP-1 to SP-6 etc.). </li> </ul> <h2>9. Key Takeaways (critical compliance points &amp; bidder risks)</h2> <ul> <li>Bids are single-stage, two-part — strict separation of techno-commercial (un-priced) and price parts; follow the upload and original-document submission rules exactly. </li> <li>EMD / BG and original document submission deadlines are strict — failure to submit originals as directed leads to rejection. EMD forfeiture clauses are strict for withdrawal/forgery/post-bid changes. </li> <li>Time schedule is binding (20 months overall; specific mechanical completion windows for key heaters). Time and sequencing linked to shutdown windows — contractors must plan for shutdown coordination</li> <li>Price bid must be lumpsum LSTK with specific form breakups; rates remain firm unless stated otherwise. Non-adherence to format may cause price evaluation/clarification issues</li> <li>Bid evaluation emphasises substantial responsiveness — deviations in key clauses (EMD, bid validity, security deposit, time schedule, scope) can render bids non-responsive</li> <li>Quality, documentation and vendor data requirements are rigorous (Document Control Index, eDMS submissions, ITPs). Non-compliance or late submissions can delay approvals. </li> </ul> <h2>10. Final Executive Summary (1–2 pages — condensed for senior management)</h2> <p> This bidding document (Bidding Document No. CK/A945-000-MC-TN-7601/1002) issued by EIL on behalf of HPCL relates to the <strong>Heater Package (New + Revamp)</strong> for the Mumbai Refinery Expansion Project (MREP). It is a large, comprehensive LSTK tender (document runs to ~2,543 pages) covering engineering, procurement, fabrication, modularization, supply, site construction/erection, inspection, testing, pre-commissioning and commissioning assistance for a set of new and modified fired heaters across the refinery. </p> <p> The procurement route is domestic competitive bidding under a single-stage, two-part system (techno-commercial then price). The commercial model is lumpsum turnkey — bidders must quote FORM SP-0 (total lump sum) with breakups (SP-1 to SP-6 and related forms) covering engineering, supply and construction. Strong emphasis is placed on bidder qualification criteria (technical experience on similar heaters, audited financials for preceding years, documentary proof, and consortium rules). Bids must include prescribed annexures such as Integrity Pact, Power of Attorney and experience proforma; originals of select documents (including EMD) must be submitted physically to EIL’s Dak Receipt Section by the due date. </p> <p> Key contractual and execution drivers: an overall contractual completion schedule of 20 months from LOA with specific faster mechanical completion windows for critical heaters (e.g., VPS heater: 16 months; PrimeG+ heater: 12 months). Shutdown coordination windows (typically 30 calendar days for commissioning assistance for certain heaters) are critical and will drive contractor scheduling and resource mobilisation. EMD/Bid security, performance guarantees (CPBG), price firming rules and tight compliance clauses are notable commercial risks. Technical deliverables include extensive vendor data requirements, ITPs, drawings, specifications and a strict document review/approval process via EIL eDMS. </p> <p> For a bidder considering participation: the tender demands comprehensive engineering &amp; fabrication capability for fired heaters (including supply of pressure and non-pressure heater parts), experience on similar heater projects, strong balance sheet &amp; audited financials, ability to meet the aggressive schedule within shutdown constraints, and exacting documentation &amp; quality assurance systems. Non-adherence to core clauses (EMD, bid validity, price format, time schedule) or submission of forged/false documents are grounds for forfeiture / bid rejection / blacklisting. </p>

    </div>
    `
  },
  {
    file_name: 'EIL',
    markup: `
        <div> <h1>Tender Summary — COOLING TOWER &amp; CWTP PACKAGE</h1> <h2>Document identity</h2> <ul> <li><strong>Bidding document no:</strong> SM/A747-304-PB-TN-8760/1035 (International Competitive Bidding). :contentReference[oaicite:0]{index=0}</li> <li><strong>Package / Title:</strong> COOLING TOWER &amp; CWTP PACKAGE. :contentReference[oaicite:1]{index=1}</li> <li><strong>Client / Owner:</strong> Ramagundam Fertilizers and Chemicals Limited (RFCL). :contentReference[oaicite:2]{index=2}</li> <li><strong>Consultant / Issuing Agency:</strong> Engineers India Limited (EIL) acting on behalf of RFCL. :contentReference[oaicite:3]{index=3}</li> <li><strong>Project:</strong> Revival of Ramagundam Fertilizer Complex Project (Ammonia &amp; Urea units). :contentReference[oaicite:4]{index=4}</li> <li><strong>Document references:</strong> e.g. Document No. A747-304-17-44-SOW-8700 (Rev. B) and A747-304-17-44-SOW-7201 (Rev. D) appear for scope and SOW sections. </li> </ul> <h2>1. Overview Section</h2> <p> <strong>Type of bidding process:</strong> Single-stage, two-part system — Part I: Techno-commercial (technical &amp; commercial) and Part II: Price part (e-bids via the Central Public Procurement Portal / eProcurement). </p> <p> <strong>Location:</strong> Ramagundam Fertilizer Complex (Telangana). :contentReference[oaicite:7]{index=7} </p> <p> <strong>Document length (as packaged):</strong> PDF contains many pages (parsed excerpts show page indices in the 500–140 range and the file references indicate a large consolidated tender file). Specific file shows "Page 514 of 2406" in the SOW excerpt — the full bid package is large. (Refer to the original PDF pages for exact pagination). :contentReference[oaicite:8]{index=8} </p> <h2>2. Scope of Work</h2> <p>High-level Turnkey scope (design → commissioning → performance guarantee):</p> <ul> <li>Design, detailed engineering, procurement, supply of materials &amp; equipment, manufacture, erection, installation, testing, painting, preservation, commissioning and performance guarantee tests of two fresh-water, re-circulating induced-draft counter-flow FRP cooling towers (CT-1 and CT-2) and associated Cooling Water Treatment Plant (CWTP). </li> <li>CT-1 (Ammonia): 7 working cells; CT-2 (Urea): 6 working cells; plus 1 common standby/spare cell shared between the two towers (interconnection arrangements defined). Capacity per cell noted (e.g. 4000 m³/hr per cell stated in SOW excerpt). :contentReference[oaicite:10]{index=10}</li> <li>CWTP &amp; dosing systems: formulation dosing, polymeric dispersant dosing, biocide dosing (including bio-dispersant), Chlorine-dioxide dosing, H₂SO₄ dosing (pH control), side-stream filtration and related chemical systems. Contractor to engage a specialist sub-vendor for design of chemical dosing system. </li> <li>Auxiliary works included: RCC basin (construction by others: contractor excludes basin sizing/hydraulic design and GA drawing of basin), sump, cold water channels (construction/GA by others), piping up to battery limits as defined by P&IDs and scope drawings, 3D modelling of package within battery limits, mechanical, electrical, instrumentation, civil works within the package boundary, supply of first-fill chemicals &amp; consumables for commissioning and six months’ chemical consumption after commissioning. </li> <li>Testing &amp; trials: trial runs for 30 days, performance guarantee run for 72 hours, training of owner’s operators for 30 days during commissioning, and six months monitoring/maintenance of the chemical dosing system after commissioning (included). :contentReference[oaicite:13]{index=13}</li> </ul> <h3>Scope boundaries / battery limits</h3> <p> Battery limits are defined by P&IDs (A747-02-41-304-1111 / 1112 / 1113) and scope limit drawing A747-304-17-44-07001. Some civil items such as construction of basin, hydraulic design of basin and cold water channel are by others; contractor has limited scope for sluice gate erection and provisions, but excludes basin sizing and GA preparation. :contentReference[oaicite:14]{index=14} </p> <h2>3. Major Facilities / Structures</h2> <ul> <li><strong>New facilities covered (major):</strong> Two induced-draft counter-flow FRP cooling towers (CT-1 and CT-2) with multiple FRP cells; common CWTP building and associated dosing/filter systems; ancillaries (fans, gearboxes, motors, corrosion probes, expansion bellows, pumps and piping inside battery limits). </li> <li><strong>Retrofitted / modified facilities:</strong> The tender includes interfaces with existing site utilities and off-site items (return headers, riser pipes up to battery limit provided by others). The spare cell connection provisions to either cooling tower imply mechanical interconnection work; contractor must provide isolation arrangements per spec. (No large standalone retrofit scope is described beyond these interfaces). </li> </ul> <h2>4. Bidder Qualification Criteria (BQC)</h2> <p> The Bidder Qualification Criteria are prescriptive. Key items extracted: </p> <ul> <li><strong>Technical experience:</strong> Contractor must have completed engineering, procurement, erection/installation and commissioning of induced-draft counter-flow cooling towers (minimum 3 cells, capacity at least 2400 m³/hr per cell OR as per specified capacity) commissioned within last 10 years from date of enquiry. The referenced cooling tower must have completed one year of operation and be FRP construction with RCC basin and film-type fill. :contentReference[oaicite:17]{index=17}</li> <li><strong>Financial criteria:</strong> <ul> <li>Minimum annual turnover: INR 358,400,000 (≈ INR 358.4 million) for Indian bidders or USD 5,491,900 for foreign bidders in at least one of the immediate preceding three financial years. :contentReference[oaicite:18]{index=18}</li> <li>Minimum net worth: INR 44,800,000 for Indian bidders or USD 686,500 for foreign bidders (as per immediate preceding year audited results). :contentReference[oaicite:19]{index=19}</li> <li>Working capital requirements and other financial detail sections are present in BQC (see full tender). :contentReference[oaicite:20]{index=20}</li> </ul> </li> <li><strong>Documentation requirements:</strong> Standard documentary proof (audited financial statements, experience certificates, completion &amp; operation certificates for referenced jobs, statutory registrations, PAN, GST/Tax, etc.). MSE bidders may provide Udhyog Aadhar/other proof to claim preference under Public Procurement Policy; absence of such documents will be treated as no preference. :contentReference[oaicite:21]{index=21}</li> <li><strong>Restrictions:</strong> Usual restrictions/clauses on blacklisting, litigation and consortium arrangements appear (see BQC clauses and ITB). Specific disqualifications (e.g., non-submission of original EMD within stipulated time) will result in bid rejection. :contentReference[oaicite:22]{index=22}</li> </ul> <h2>5. Commercial &amp; Contractual Conditions</h2> <ul> <li><strong>EMD / Bid security:</strong> Bidders must furnish EMD (interest-free) as indicated in the Invitation for Bids. Uploading a scanned copy is allowed at bid submission time but original EMD in physical form must reach Tender Processing Section within 10 days from bid due date (subject to office holidays). Failure to submit original EMD within this period leads to rejection. No EMD exemption for Central Public Sector Undertakings/Enterprises unless specified. </li> <li><strong>Price schedule / SOR submission:</strong> Price Schedule / SOR shall be strictly in the provided RAR format (no modification allowed); any modification leads to rejection. Electronic submission procedures and file size limits are specified. :contentReference[oaicite:24]{index=24}</li> <li><strong>Time for completion &amp; price reduction for delay:</strong> Time is of the essence. If contractor fails to complete within Time for Completion, Contract Price shall be reduced by 1% per week (or part thereof) subject to a maximum of 10% of Contract Price (price reduction provision; not treated as liquidated damages under Indian Contract Act). The Engineer-in-Charge’s decision on applicability of reduction is final. Provisions for extension of time are defined subject to specified events. </li> <li><strong>General/Special conditions:</strong> Standard EIL / RFCL GCC clauses apply (labour, visa rules for foreign nationals, employment of local labour, contractor’s obligations, termination rights, etc.). Refer to GCC sections for details. </li> <li><strong>Payment terms &amp; Guarantees:</strong> Contract Performance Bank Guarantee and other standard payment/guarantee provisions are referenced in GCC and price reduction clauses (set-off / invocation of PBG if amounts due). Exact payment milestones and retention clauses appear in contract documents — consult contract conditions and SCC for specifics. :contentReference[oaicite:27]{index=27}</li> <li><strong>Penalties:</strong> Price reduction for delay specified (1%/week max 10%). Other penalties (for manpower non-deployment, defects liability, liquidated damages where applicable) will be in GCC/SCC (refer to relevant clauses). :contentReference[oaicite:28]{index=28}</li> </ul> <h2>6. Technical Conditions</h2> <ul> <li><strong>Technical specifications included:</strong> Detailed technical specs for cooling towers (FRP induced draft, PVC film-type fills), mechanical equipment (fans, gearboxes, motors), structural interfaces, electrical &amp; instrumentation, chemical dosing equipment, side-stream filters, corrosion probes/coupons and other accessories. SOW and separate specification sections define the standards and materials. </li> <li><strong>Standards &amp; codes:</strong> Tender references applicable standards and data sheets (see technical specification sections in the bid package). Bidders must comply with these standards — refer to the Standards &amp; Codes list in the technical specifications. :contentReference[oaicite:30]{index=30}</li> <li><strong>Quality, inspection &amp; testing:</strong> The scope includes testing, trial runs (30 days), performance guarantee run (72 hours), equipment inspection, and third-party / employer inspections as prescribed. Quality management provisions (inspection plans, hold points, test certificates) are included in the technical &amp; QA sections. :contentReference[oaicite:31]{index=31}</li> <li><strong>3D modelling:</strong> 3D modelling of cooling tower and package facilities (piping, equipment, structures) is required within package battery limits. :contentReference[oaicite:32]{index=32}</li> </ul> <h2>7. Tendering Process</h2> <ul> <li><strong>Pre-bid meeting / clarifications:</strong> The bid advert and ITB will specify pre-bid meeting date, venue and contacts. (Search the ITB / Notice for exact pre-bid date/time/venue and contact details in the tender folder). :contentReference[oaicite:33]{index=33}</li> <li><strong>Bid submission deadlines:</strong> Deadlines and server time rules are specified; bidders must follow the server time displayed on the portal. (Exact bid due date/time — see IFB / Tender Notice in the original PDF). :contentReference[oaicite:34]{index=34}</li> <li><strong>Mode of submission:</strong> Electronic e-bidding via Government eProcurement portal (http://eprocure.gov.in/eprocure/app) is specified; price schedule must be submitted in provided format. Physical original EMD / instruments to be sent per ITB instructions. </li> <li><strong>Bid opening:</strong> Two-part system — techno-commercial part opened first; price part opened for bidders who qualify the techno-commercial evaluation. Opening procedures, sequence and portal rules are described in ITB. :contentReference[oaicite:36]{index=36}</li> <li><strong>Corrigenda &amp; clarifications:</strong> Clarifications and corrigenda will be issued on the eProcurement portal; bidders are advised to monitor the portal and use the "My Tenders" folder for notifications. :contentReference[oaicite:37]{index=37}</li> </ul> <h2>8. Mandatory Annexures &amp; Forms</h2> <p> The tender package includes multiple mandatory forms and annexures. Key items called out in the bid guidance: </p> <ul> <li>Integrity Pact (if required by tender) and associated declarations. (See Annexure list in ITB).</li> <li>Acknowledgement / Consent letters, affidavits and undertakings (statutory declarations, no-blacklist declarations, malpractice disclaimers, etc.).</li> <li>Formats for bidder’s information, experience &amp; compliance matrix, price schedule (provided RAR file), SOR, technical compliance statements, and statutory documents (PAN, audited financials, certificates). </li> </ul> <h2>9. Drawings, SOR &amp; Price Schedules</h2> <ul> <li><strong>Schedule of Rates (SOR) / Price Schedule:</strong> Price Schedule must be submitted in the exact format provided (RAR). The portal enforces file size/format constraints and disallows alterations to the Price Bid file; modified files will be rejected. :contentReference[oaicite:39]{index=39}</li> <li><strong>Drawings &amp; P&amp;IDs:</strong> Scope refers to P&IDs A747-02-41-304-1111/1112/1113 and scope limit drawing A747-304-17-44-07001. SOW document numbers listed for package drawings. Bidders should download and reference the full drawing set included in the bid package. :contentReference[oaicite:40]{index=40}</li> <li><strong>Datasheets:</strong> Equipment data sheets and technical data sheets are part of the tender package (check Annexures &amp; data sheets folder). :contentReference[oaicite:41]{index=41}</li> </ul> <h2>10. Key Takeaways (Risks &amp; Critical Compliance Points)</h2> <ul> <li><strong>Strict BQC and financial thresholds:</strong> The technical and financial eligibility limits are strict (experience with FRP towers and specified capacity; turnover and networth thresholds). Non-compliance will lead to disqualification. :contentReference[oaicite:42]{index=42}</li> <li><strong>Original EMD requirement:</strong> Although a scanned EMD can be uploaded during e-submission, the original instrument must arrive within 10 days — failure = rejection. Ensure courier timelines and bank instruments match uploaded details. :contentReference[oaicite:43]{index=43}</li> <li><strong>Price schedule format is mandatory:</strong> Submitting price in any other format or altering the supplied Price Bid file will cause rejection. :contentReference[oaicite:44]{index=44}</li> <li><strong>Time &amp; delay penalties:</strong> Price reduction for delay is onerous — 1%/week up to 10% — and does not remove obligations to complete work. Programme and critical path management will be important. :contentReference[oaicite:45]{index=45}</li> <li><strong>Interfaces &amp; exclusions:</strong> Civil works like basin construction and cold water channel hydraulic design are by others; bidders must carefully note battery limits to avoid scope disputes. :contentReference[oaicite:46]{index=46}</li> <li><strong>Specialist sub-vendor requirement:</strong> Contractor must engage a specialist for chemical dosing system design — plan procurement and sub-vendor management early. :contentReference[oaicite:47]{index=47}</li> </ul> <h2>11. Final Executive Summary (Concise narrative for senior management)</h2> <p> <strong>What this tender is for:</strong> EIL, on behalf of RFCL, invites international competitive bids for the turnkey supply, erection, testing, commissioning and performance guarantee of two fresh-water induced-draft counter-flow FRP cooling towers (one serving the Ammonia unit and one serving the Urea unit) plus a common Cooling Water Treatment Plant (CWTP) and all associated mechanical, electrical, instrumentation and package civil works within defined battery limits. The package includes 3D modelling, specialist chemical dosing design (via sub-vendor), trial runs, performance testing and six months of chemical support following commissioning. </p> <p> <strong>Commercial &amp; bidding essentials:</strong> The tender is single-stage two-part (techno-commercial then price) through the Government eProcurement portal. Bidders must meet prescriptive technical experience (completed FRP induced-draft cooling towers of required size with at least one year operation), and financial thresholds (minimum audited turnover and net-worth). Strict compliance is required for price schedule format, submission rules and original EMD submission (physical instrument within 10 days). Time is of the essence; price reduction for delay (1%/week, up to 10%) applies. </p> <p> <strong>Risks &amp; strategic advice:</strong> Key bidder risks include strict BQC (experience &amp; financial), the need to coordinate specialist sub-vendors (chemical dosing), tight compliance on price schedule/EMD and the interface exclusions (basin &amp; certain civil works by others). Programme risk is material because of the price reduction clause. Bidders should ensure documentary evidence for claimed past projects (commissioning &amp; one-year operation certificates), prepare the mandatory un-altered Price Bid RAR file in advance, and arrange timely physical delivery of EMD. Also anticipate employer inspections, hold points and QA records during execution. </p>
        </div>
    `
  },
  {
    file_name: 'BS-VI_CPCL',
    markup: `
        <div> <h1>Tender Summary — BUILDING WORKS for BS-VI Auto Fuels Project (CPCL, Manali)</h1> <!-- 1. Overview --> <section> <h2>1. Overview</h2> <ul> <li><strong>Project name:</strong> BUILDING WORKS for BS-VI Auto Fuels Project of M/s Chennai Petroleum Corporation Ltd. (CPCL), Manali Refinery, Chennai.</li> <li><strong>Bidding document no.:</strong> AS/A927-000-CF-TN-8201/1008.</li> <li><strong>Client / Employer:</strong> Chennai Petroleum Corporation Ltd. (CPCL).</li> <li><strong>Consultant / Employer's Representative:</strong> Engineers India Limited (EIL) — tender issued / managed through EIL on behalf of CPCL.</li> <li><strong>Location:</strong> CPCL Manali Refinery, Manali, Chennai, Tamil Nadu (site address and contact details included).</li> <li><strong>Type of bidding:</strong> Domestic Competitive Bidding — <em>Single stage, two-bid system</em> (e-bids in three parts: Part-I EMD, Part-II Techno-commercial/unpriced, Part-III Priced).</li> <li><strong>Total document length (PDF):</strong> full bid package (complete PDF package supplied with the tender).</li> </ul> </section> <!-- 2. Scope of Work --> <section> <h2>2. Scope of Work (Summary)</h2> <p>Broadly the contract covers civil & structural works for new buildings and retrofitting existing buildings across the BS-VI upgrade scope, plus associated MEP/ITS/ventilation and HSE requirements. Detailed scope and SOR are included in the Structural & Architectural SOW documents.</p>
            <h3>Major elements</h3>
            <ul>
            <li><strong>Civil & Structural:</strong> RCC & masonry for sub-structure and super-structure for new buildings and retrofits; foundation strengthening where required; structural steel works (staircases, ladders, handrails); trenches and earthwork including dewatering/shoring; controlled demolition & specialized retrofitting (epoxy injection, guniting).</li>
            <li><strong>Retrofitting / modifications:</strong> Replace brick walls with RCC walls, strengthen foundations/columns/beams/slabs, envelope works, selective demolition with protection of in-service facilities.</li>
            <li><strong>Mechanical / Plumbing:</strong> Water tanks, plumbing, sanitary lines, rainwater harvesting, dewatering pumps for cable cellars; provision and installation of valves and traps.</li>
            <li><strong>Electrical / ITS / HVAC / Ventilation:</strong> Works include related electrical installation for buildings, ITS (satellite/rack rooms), air-conditioning for applicable rooms, ventilation/pressurization for substation areas.</li>
            <li><strong>Other:</strong> Temporary supports and protection for existing piping/equipment, supply & installation of HDPE/GI pipes for sewerage/drinking water, gully/inspection chambers, as-built drawings and documentation.</li>
            </ul>

            <p><em>Scope documents available:</em> Part A (Structural) SOW, Part B (Architectural) SOW, Schedule of Rates (SOR), drawings and datasheets (all included in the bid package).</p>

            </section> <!-- 3. Major Facilities/Structures --> <section> <h2>3. Major Facilities & Structures</h2> <h3>New buildings (indicative list)</h3> <ul> <li>SRU Control Room.</li> <li>SRU Substation.</li> <li>Satellite Rack Room – FCC GDS.</li> </ul>
            <h3>Retrofitted / Modified buildings</h3>
            <ul>
            <li>Existing Control Room (retrofitting and masonry/RCC replacement).</li>
            <li>Satellite Rack Room-1 (modification & strengthening).</li>
            <li>DHDT Substation (retrofitting works).</li>
            </ul>

            </section> <!-- 4. Bidder Qualification Criteria (BQC) --> <section> <h2>4. Bidder Qualification Criteria (BQC)</h2> <p>The tender contains a standard EIL/EPC style BQC: bidders must demonstrate relevant experience, financial strength and provide documentary proof. Only bidders meeting BQC will be considered for techno-commercial evaluation.</p>
            <h3>Experience requirements</h3>
            <ul>
            <li>Only experience of the bidding entity is normally considered (jobs for own plant not accepted; jobs for subsidiary/fellow subsidiary/holding company accepted subject to auditor-certified tax invoices).</li>
            <li>Complete work orders, SOR pages, completion certificates (owner/PMC) showing ordered & executed value, scope, and completion date must be submitted. Sub-contractor experience is acceptable with additional documentation (work order by main contractor + completion certs).</li>
            </ul>

            <h3>Financial criteria</h3>
            <ul>
            <li>Submission of audited financial statements for the preceding three financial years (Balance Sheet, P&L, auditor reports) is mandatory for assessment. Definitions and calculation method for Net Worth and Working Capital are specified.</li>
            <li>Net Worth = paid up share capital + share application money pending allotment + reserves (with exclusions) – accumulated losses – deferred expenditure (detailed definition in BQC). Working capital = Current Assets – Current Liabilities.</li>
            </ul>

            <h3>Documentation requirements</h3>
            <ul>
            <li>Work orders, completion certificates, SOR extracts, audited annual reports, and other supporting documents must be uploaded as part of the bid. EIL may pre-qualify based on documents submitted — submit as many relevant jobs as possible.</li>
            </ul>

            <h3>Restrictions & other conditions</h3>
            <ul>
            <li>Bidders blacklisted or on holiday/negative lists of Owner/EIL at bid submission or during evaluation will be rejected.</li>
            <li>Zero-deviation policy — bids must be “Zero deviation basis” (no deviations permitted; deviations may cause rejection).</li>
            <li>Consortium / sub-contracting: subcontractor experience is allowed with documentary proof as specified; full details in BQC clauses.</li>
            </ul>

            </section> <!-- 5. Commercial & Contractual Conditions --> <section> <h2>5. Commercial & Contractual Conditions</h2>
            <h3>EMD / Bid Security</h3>
            <ul>
            <li>Bid submission is three-part; Part-I contains EMD / Bid Security. Scanned copy uploaded and original submitted physically to specified address (Dak Receipt Section, EIL Gurugram) within the deadline. Non-receipt of original bid security will invalidate the bid irrespective of e-submission.</li>
            </ul>

            <h3>Time for completion</h3>
            <ul>
            <li>Contract time: <strong>14 (fourteen) months</strong> from date of issue of Letter of Acceptance (effective date) to complete all works. Details and notes on fronts/release of fronts are in Annexure to SCC.</li>
            </ul>

            <h3>Payment terms & guarantees</h3>
            <ul>
            <li>Terms of payment and Contract Performance Guarantee are specified in SCC / Annexures (detailed payment schedule included in SCC annexure titled “Terms of Payment”). Refer SCC Part for exact percentages, interim payments, retention and release conditions.</li>
            </ul>

            <h3>Penalties & other commercial clauses</h3>
            <ul>
            <li>Penalties for delay, manpower non-deployment, and other defaults are covered in GCC/SCC — contractors should review SCC carefully. Time extension and amendment rules are provided (EIL may extend deadline to allow bidders to consider addenda).</li>
            <li>Prices quoted must be in the format provided and remain firm till completion unless otherwise specified. Currency — Indian Rupees (unless BDS states otherwise).</li>
            </ul>

            </section> <!-- 6. Technical Conditions --> <section> <h2>6. Technical Conditions</h2>
            <h3>Technical specifications & standards</h3>
            <ul>
            <li>Technical specifications include structural, architectural and discipline-wise requirements contained in Part-A (Structural) and Part-B (Architectural) SOW documents, plus specific datasheets and addendums. Standards and codes referenced throughout SOW and technical spec sections — contractor must comply with the listed standards and inspection requirements.</li>
            </ul>

            <h3>Quality, inspection & testing</h3>
            <ul>
            <li>Quality management system requirements, documentation requirements and final as-built documentation format are specified (binding hard copies, indexed volumes, soft file uploads to EIL eDMS). NDT/radiography and documentation standards for mechanical/composite items also appear in SCC.</li>
            <li>Contractor to obtain statutory approvals (DISH, municipal authorities), appoint DISH-approved competent persons where required, and submit building stability & compliance certificates.</li>
            </ul>

            </section> <!-- 7. Tendering Process --> <section> <h2>7. Tendering Process</h2>
            <h3>Key dates & pre-bid</h3>
            <ul>
            <li>Tender availability period and pre-bid meeting dates are published in the Notice Inviting Tender (NIT). Pre-bid participation is encouraged; bidders must submit queries in the prescribed format ahead of the meeting.</li>
            <li>Pre-bid participation encouraged; bidders expected to come prepared with technical & commercial queries — queries should be submitted in the prescribed format at least two days prior to pre-bid meeting.</li>
            </ul>

            <h3>Submission & opening</h3>
            <ul>
            <li>Online e-submission only via CPP Portal (e-procure) for e-bids. Bidders should upload required documents in specified file formats (PDF/XLS/RAR/DWF) and use “My Space” to avoid repeated uploads. Price schedule / SOR must be strictly in RAR format as provided. Physical submission is required only for original EMD and certain originals to the specified EIL address.</li>
            <li>Part-wise opening: Part-I (EMD) verification first; techno-commercial (Part-II) opening then; price bids (Part-III) opened for only the bidders who are techno-commercially acceptable — bidders will be intimated of price bid opening date/time.</li>
            <li>Bid closing time, techno-commercial opening time and other schedule details are shown in the BDS; bidders must check the current BDS for exact dates/times.</li>
            </ul>

            <h3>Corrigenda & clarifications</h3>
            <ul>
            <li>All corrigenda / amendments / clarifications released on the websites only; EIL may extend deadlines if an addendum is issued. Bidders are responsible to check the portal for updates.</li>
            <li>Post-opening clarifications are managed in writing only; zero-deviation policy applies. Attempts to influence evaluation may lead to rejection.</li>
            </ul>

            </section> <!-- 8. Mandatory Annexures & Forms --> <section> <h2>8. Mandatory Annexures & Forms</h2> <ul> <li>Package includes standard Forms and Annexures: Invitation for Bid (IFB), Instructions to Bidders (ITB), Bid Data Sheet (BDS), Bidding Forms, General Conditions of Contract (GCC), Special Conditions of Contract (SCC), Schedule of Rates (SOR) / Schedule of Prices (SOP), Technical Specifications, drawings and attachments.</li> <li>Specific mandatory forms: Integrity Pact (where applicable), Offer covering letter, Master Index with signed acceptance of all parts/amendments, undertaking/affidavits, formats for bidder information and compliance statements. Upload requirements for each part are specified in ITB clause listing.</li> <li>Original documents required physically (e.g., original EMD) must be delivered to the EIL address by the deadline.</li> </ul> </section> <!-- 9. Drawings, SOR & Price Schedules --> <section> <h2>9. Drawings, SOR & Price Schedules</h2> <ul> <li>Schedule of Rates (SOR) / Schedule of Prices (SOP) included. Price schedule must be submitted in the exact format provided (RAR) and not altered.</li> <li>Multiple drawings, datasheets and technical annexures accompany the SOW — bidders must study “List of Attachments” and all referenced drawings. As-built and final documentation format requirements are specified for submission at completion.</li> </ul> </section> <!-- 10. Key Takeaways --> <section> <h2>10. Key Takeaways (Risks & Critical Compliance Points)</h2> <ul> <li><strong>Zero deviation policy:</strong> The tender enforces a strict “zero deviation” submission; any deviations may lead to rejection. Ensure full compliance with terms, formats and document checklists.</li> <li><strong>EMD original required physically:</strong> A scanned copy is uploaded with the e-bid but the original EMD must reach the EIL office before the submission deadline — failure invalidates the bid.</li> <li><strong>Document completeness matters:</strong> EIL may pre-qualify based solely on submitted documents — provide comprehensive evidence for experience & financials up front.</li> <li><strong>Time for completion:</strong> 14 months total — review programme, fronts, and mobilization requirements; SCC includes release of fronts clauses and mobilization expectations.</li> <li><strong>Statutory approvals & HSE:</strong> Contractor responsible for statutory approvals (DISH, municipal), certificate submissions and HSE management. Non-compliance will affect progress & payments.</li> <li><strong>Price format rigidity:</strong> Price schedule in provided format only; conditional discounts not acceptable. Prices remain firm unless explicit clause provides for variation.</li> </ul> </section> <!-- 11. Final Executive Summary (1-2 page narrative style — condensed) --> <section> <h2>11. Final Executive Summary (Condensed — for senior management)</h2>
            <p><strong>Project & context:</strong> This tender covers the civil/structural, architectural and associated building works for the BS-VI Auto Fuels upgrade at CPCL’s Manali refinery, issued by Engineers India Limited on behalf of CPCL. The package is part of a larger refinery upgrade that includes new SRU, ARU, SWS, FCC GDS, DHDT capacity augmentation and utilities/offsite works. The building works contract includes new construction (SRU control room, SRU substation, satellite rack rooms) and retrofitting of existing control rooms, rack rooms and substations.</p>

            <p><strong>Scope & technical requirements:</strong> The contractor will perform comprehensive civil and structural works — RCC and masonry for foundations, columns, beams and walls; replacement of brickwork with RCC where specified; structural steel fabrication and installation; trenching, dewatering and earthworks; demolition where required with controlled methods to avoid impact on operational plant; mechanical (plumbing, water tanks, rainwater harvesting) and building MEP (electrical, ITS, HVAC and ventilation/pressurization for substations). Statutory approvals (e.g., DISH) and final as-built documentation (hard & soft) are mandatory deliverables. Quality control, NDT, documentation and compliance to referenced standards are explicitly required.</p>

            <p><strong>Commercial & procurement process:</strong> The tender is Domestic Competitive Bidding under a single-stage two-bid e-tender system. Bids must be submitted online via the CPP Portal in three parts; an original EMD must also be delivered physically to EIL. Price schedules must be submitted only in the provided format. The contract period is 14 months from the Letter of Acceptance. The SCC contains payment mechanics, performance guarantee, HSE and other site-specific conditions.</p>

            <p><strong>BQC & bidder risk:</strong> Bidders must provide comprehensive documentary evidence for prior experience and finances (audited statements for last three years). Subcontractor experience is admissible with supporting proofs, but work for one’s own plant is normally not accepted as qualifying experience. There is a strict zero-deviation policy; deviations can lead to rejection. Bidders on EIL/Owner negative lists will be disqualified.</p>

            <p><strong>Immediate bidder actions (recommended checklist):</strong>
            <ol>
            <li>Download full bid package and all amendments; maintain a master index signed as required.</li>
            <li>Prepare and upload Part-I (EMD scan), Part-II (complete techno-commercial documents including BQC evidence) and Part-III (priced SOR in RAR) strictly in formats requested. Submit original EMD to the Dak Receipt Section at EIL Gurugram by the bid deadline.</li>
            <li>Attend pre-bid meeting (or ensure you have noted clarifications) and submit pre-bid queries in the prescribed format at least two days before the meeting.</li>
            <li>Prepare construction programme respecting the 14-month completion and plan for phased front releases. Prepare statutory approval timelines (DISH, local municipal).</li>
            <li>Ensure robust documentation pack for BQC (work orders, completion certificates, audited financials and SOR extracts).</li>
            </ol>
            </p>

            <p><strong>Conclusion:</strong> This is a comprehensive and document-heavy EIL/CPCL building works package with strict compliance requirements (zero deviations, original EMD submission, format-locked SOR). The works involve structural strengthening and retrofitting in an operational refinery environment — bidders should price for careful temporary protection, phased execution, statutory approvals and rigorous documentation & quality regimes. Non-compliance to the procedural/formatting requirements risks disqualification irrespective of technical capability.</p>

            </section> <!-- End / References --> <section> <h2>References & where to look inside the package</h2> <ul> <li>Instructions to Bidders (ITB) — contains BQC, bid submission/format/EMD/part-wise opening and zero-deviation clauses.</li> <li>Scope of Works & Supply (Structural & Architectural) — Part-A (structural) & Part-B (architectural) SOWs, SOR, drawings and addendums.</li> <li>Special Conditions of Contract (SCC) & Annexures — time for completion, terms of payment and site conditions.</li> <li>Documentation specification & final deliverables (as-built) — standards for hard/soft documentation and submission.</li> </ul> </section> <footer>

            </footer> </div>
    `
  }
];
