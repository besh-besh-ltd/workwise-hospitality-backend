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
    file_name: "gmpl_composite_works",
    markup: `
      <div>
      <h2 class="mb-3 text-primary">Tender Summary – GMPL Composite Works</h2>

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
                  <td>GMPL, Village Bajpe, Mangalore SEZ Ltd., Karnataka – 574142</td>
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
    file_name: "mrpl_depot_automation_works",
    markup: `
      <div>
      <h2 class="mb-3 text-primary">Tender Summary – MRPL Depot Automation Works</h2>

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
                      <strong>MRPL Petroleum Oil Depot, Kasaragod:</strong> Plot No. 15 to 19, KINFRA Small Industries Park, Seethangoli, Maipady P.O., Kasaragod – 671124, Kerala<br>
                      <strong>MRPL Depot, Hosur:</strong> E.11, SIPCOT Phase 2 Expansion 1, Moranapalli, Hosur – 635109, Tamil Nadu
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
    file_name: "iocl",
    markup: `
      <div>
      <h2 class="mb-3 text-primary">
          Tender Summary – Mechanical, Piping & Insulation Works for CRU Project at IOCL Guwahati Refinery (Part A & Part B)
      </h2>

      <!-- Basic Tender Info -->
      <h4 class="mt-4 text-secondary">1. Basic Tender Info</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th style="width:25%;">Title</th>
                  <td>Mechanical, Piping & Insulation Works for CRU Project at IOCL Guwahati Refinery (Part A & Part B)</td>
              </tr>
              <tr>
                  <th>Tender No.</th>
                  <td>213102-00123-C-020</td>
              </tr>
              <tr>
                  <th>Issued By</th>
                  <td>Worley Services India Pvt. Ltd. (EPCM consultant for IOCL)</td>
              </tr>
              <tr>
                  <th>Location</th>
                  <td>Guwahati Refinery, Assam</td>
              </tr>
              <tr>
                  <th>Type</th>
                  <td>Domestic Competitive Bidding (E-Bidding), Single-Stage Two-Bid System with <strong>Reverse Auction</strong></td>
              </tr>
              <tr>
                  <th>Tender Portal</th>
                  <td><a href="https://iocletenders.nic.in" target="_blank">https://iocletenders.nic.in</a></td>
              </tr>
              <tr>
                  <th>DSC Requirement</th>
                  <td>Class-3 DSC (mandatory for new registrations)</td>
              </tr>
          </tbody>
      </table>

      <!-- Scope of Work -->
      <h4 class="mt-4 text-secondary">2. Scope of Work</h4>
      <ul>
          <li><strong>Core:</strong> Piping fabrication & erection (CS/AS/SS), painting, insulation, equipment erection/installation, associated works as per SOR, specs, drawings.</li>
          <li><strong>Responsibility:</strong> Single-point responsibility contractor.</li>
          <li><strong>Special Requirements:</strong> Work during monsoon, mobilization of minimum equipment & key manpower, adherence to IOCL PPE guidelines, helmet colour codes, and IFR coverall policy.</li>
      </ul>

      <!-- Financials -->
      <h4 class="mt-4 text-secondary">3. Financials</h4>
      <table class="table table-bordered table-sm">
          <tbody>
              <tr>
                  <th>EMD</th>
                  <td>₹1,93,000 (BG/NEFT/RTGS/Online Net Banking)</td>
              </tr>
              <tr>
                  <th>Exemptions</th>
                  <td>MSEs, Startups, Govt. PSUs (valid proof required)</td>
              </tr>
              <tr>
                  <th>Tender Cost</th>
                  <td>Free download from portal</td>
              </tr>
              <tr>
                  <th>EMD Refund</th>
                  <td>Same account to remain active until award</td>
              </tr>
          </tbody>
      </table>

      <!-- Eligibility -->
      <h4 class="mt-4 text-secondary">4. Eligibility (BQC)</h4>
      <ul>
          <li><strong>Experience (last 10 years):</strong>
              <ul>
                  <li>1 work ≥ ₹3.0837 Cr OR</li>
                  <li>2 works ≥ ₹2.3128 Cr each OR</li>
                  <li>3 works ≥ ₹1.5419 Cr each</li>
              </ul>
          </li>
          <li><strong>Similar Work:</strong> Mechanical works involving equipment erection + CS/AS/SS piping in refineries/petrochemical/fertilizer/O&G terminals.</li>
          <li><strong>Financial:</strong> Annual Turnover ≥ ₹4.6255 Cr (any of last 3 FYs).</li>
          <li><strong>Mandatory Registrations:</strong> Indian PF, ESI (or undertaking), PAN, legal constitution docs.</li>
          <li><strong>Integrity Pact:</strong> Applicable (as per IOCL policy)</li>
      </ul>

      <!-- Key Dates -->
      <h4 class="mt-4 text-secondary">5. Key Dates</h4>
      <table class="table table-bordered table-sm">
          <thead class="table-light">
              <tr>
                  <th>Activity</th>
                  <th>Date</th>
                  <th>Time</th>
              </tr>
          </thead>
          <tbody>
              <tr>
                  <td>Tender Download</td>
                  <td>09-May-2025 → 23-May-2025</td>
                  <td>1600 hrs</td>
              </tr>
              <tr>
                  <td>Pre-Bid Meeting</td>
                  <td>15-May-2025</td>
                  <td>1100 hrs</td>
              </tr>
              <tr>
                  <td>Bid Submission</td>
                  <td>23-May-2025</td>
                  <td>1600 hrs</td>
              </tr>
              <tr>
                  <td>Techno-Commercial Opening</td>
                  <td>26-May-2025</td>
                  <td>1600 hrs</td>
              </tr>
          </tbody>
      </table>

      <!-- Completion Timeline -->
      <h4 class="mt-4 text-secondary">6. Completion Timeline</h4>
      <ul>
          <li><strong>Mechanical completion:</strong> 6 months from NOA.</li>
          <li><strong>Commissioning assistance:</strong> Additional 2 months.</li>
      </ul>

      <!-- Contract & Commercial Terms -->
      <h4 class="mt-4 text-secondary">7. Contract & Commercial Terms</h4>
      <ul>
          <li>Splitting: 60% (L1) + 40% (L2 at L1 rates).</li>
          <li>Tie-break: Discount bid in sealed envelope; turnover-based decision if still tied.</li>
          <li>PPP-MII Policy applicable.</li>
          <li>EMD Forfeiture for bid withdrawal, fake docs, or failure to sign contract.</li>
          <li>Rejection Grounds: BOQ tampering, photocopied/scanned BOQ, modification of BOQ sheets.</li>
      </ul>

      <!-- Safety, Health & Environment -->
      <h4 class="mt-4 text-secondary">8. Safety, Health & Environment</h4>
      <p><strong>Annexure A-VI:</strong> Worley’s Field HSE Specification (IND-SS-Z-007 Rev. 09)</p>
      <ul>
          <li><strong>Objectives:</strong> “Zero harm” – no lost-time injuries, reportable injuries, or environmental/property incidents.</li>
          <li><strong>Critical Risk Management:</strong> Pre-job risk assessment, PPE rules, emergency response.</li>
      </ul>
      <h6 class="mt-3">Key Risk Areas</h6>
      <ul>
          <li><strong>Work at height:</strong> 100% fall protection ≥ 6 ft; rescue plan; scaffold & ladder safety.</li>
          <li><strong>Lifting operations:</strong> Critical lifts (>50 t, >85% capacity, tandem, over active areas); qualified operators/riggers; taglines; wind speed limits.</li>
          <li><strong>Mobile equipment:</strong> Traffic plan; restrictions on “pick-and-carry” cranes without outriggers.</li>
          <li><strong>Other Provisions:</strong> Confined space entry, electrical safety, welding/cutting permits, scaffolding inspections, housekeeping, fire prevention, medical readiness, penalties for violations.</li>
      </ul>

      <!-- Technical & Contractual Provisions -->
      <h4 class="mt-4 text-secondary">9. Technical & Contractual Provisions (Vol IV)</h4>
      <ul>
          <li>Contract Type: Item rate contract (SOR-based quantities).</li>
          <li>Price Basis: Firm & fixed; escalation only for statutory tax changes.</li>
          <li>Taxes/Duties: GST extra; e-invoicing compliance if applicable.</li>
          <li>Payment Terms: Progressive RA bill payments; final after mechanical completion & acceptance.</li>
          <li>Security Deposit: 3% of contract value (from RA bills or BG).</li>
          <li>Insurance: Workmen’s Compensation, Contractor’s All Risk, Third-Party, Transit — covering from mobilization till acceptance.</li>
          <li>Liquidated Damages: 0.5% per week (max 5%).</li>
          <li>Force Majeure: Standard IOCL clause.</li>
          <li>Termination: By Owner (convenience/default) or Contractor (prolonged suspension/non-payment).</li>
          <li>Arbitration & Jurisdiction: As per Indian Arbitration & Conciliation Act; Assam jurisdiction.</li>
      </ul>

      <!-- Submission Rules -->
      <h4 class="mt-4 text-secondary">10. Submission Rules</h4>
      <ul>
          <li>Formats: PDF, XLS (97–2003), JPG, RAR.</li>
          <li>Bid Freeze: Must click “FREEZE BID SUBMISSION” to confirm.</li>
          <li>Resubmission Allowed until deadline (tech/financial docs only).</li>
          <li>Withdrawal Allowed — but bidder cannot re-participate.</li>
      </ul>

      <!-- Helpdesk Contacts -->
      <h4 class="mt-4 text-secondary">11. Helpdesk Contacts</h4>
      <table class="table table-bordered table-sm">
          <thead class="table-light">
              <tr>
                  <th>Issue Type</th>
                  <th>Contact</th>
                  <th>Email</th>
                  <th>Phone</th>
              </tr>
          </thead>
          <tbody>
              <tr>
                  <td>Portal Technical</td>
                  <td>Mr. Ravi (Kolkata)</td>
                  <td><a href="mailto:etenderinghelpdesk@indianoil.in">etenderinghelpdesk@indianoil.in</a></td>
                  <td>+91-33-24145981</td>
              </tr>
              <tr>
                  <td>Payment Gateway</td>
                  <td>ICICI Bank</td>
                  <td><a href="mailto:etendering@icicibank.com">etendering@icicibank.com</a></td>
                  <td>022-61376644</td>
              </tr>
          </tbody>
      </table>
  </div>
    `
  }
]
