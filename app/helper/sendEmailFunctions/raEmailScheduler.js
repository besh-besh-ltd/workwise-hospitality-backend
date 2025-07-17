import { createSchedule } from '../createSchedule.js';
import rfqModel from '../../models/rfqModel.js';
import vendorModel from '../../models/vendorModel.js';

function parseDate(dateString, timezone = 'UTC') {
    if (!dateString) return null;
    try {
        const date = new Date(dateString);
        return isNaN(date.getTime()) ? null : date;
    } catch (error) {
        console.error('Error parsing date:', error);
        return null;
    }
}

function createCronString(date, timezone = 'UTC') {
    return {
        pattern: `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`,
        timezone
    };
}

function formatDate(date) {
    return date.toISOString();
}

/**
 * Accepts "YYYY‑MM‑DDTHH:mm"  or  "YYYY‑MM‑DD HH:mm"
 * Returns a JS Date in **UTC** that represents the same clock
 * time in IST (+05:30).
 */
function parseISTDate(datetimeStr = '') {
  if (!datetimeStr) {
    throw new Error('Empty date string');
  }

  // Normalize input string
  let s = datetimeStr.trim().replace('T', ' ');
  if (!/\d{2}:\d{2}/.test(s)) s += ' 00:00';

  const [datePart, timePart] = s.split(' ');
  if (!datePart || !timePart) {
    throw new Error(`Invalid date format: ${datetimeStr}`);
  }

  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm = 0] = timePart.split(':').map(Number);

  if ([y, m, d, hh, mm].some(v => isNaN(v))) {
    throw new Error(`Invalid date components: ${datetimeStr}`);
  }

  // Create JS Date in local time (assumed to be IST if machine is set to IST)
  const localDate = new Date(y, m - 1, d, hh, mm);

  // Format to IST ISO-like string (without Z or UTC shift)
  const yyyy = localDate.getFullYear();
  const MM = String(localDate.getMonth() + 1).padStart(2, '0');
  const dd = String(localDate.getDate()).padStart(2, '0');
  const HH = String(localDate.getHours()).padStart(2, '0');
  const mmStr = String(localDate.getMinutes()).padStart(2, '0');

  const istFormatted = `${yyyy}-${MM}-${dd}T${HH}:${mmStr}:00`;

  console.log('Parsed IST date:', istFormatted);
  return istFormatted;
}

/**
 * Helper function to create a Date object from IST string for calculations
 * while preserving the IST format for scheduling
 */
function createDateFromIST(istDateString) {
  const [datePart, timePart] = istDateString.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss = 0] = timePart.split(':').map(Number);
  
  return new Date(y, m - 1, d, hh, mm, ss);
}

/**
 * Adjusts IST date string for weekends
 */
function adjustISTDateForWeekend(originalISTDate, type) {
  const date = createDateFromIST(originalISTDate);
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday

  if (type === 'start') {
    // If Saturday, subtract 1 day (Friday)
    if (day === 6) {
      date.setDate(date.getDate() - 1);
    }
    // If Sunday, subtract 2 days (Friday)
    else if (day === 0) {
      date.setDate(date.getDate() - 2);
    }
  } else if (type === 'end') {
    // If Saturday, add 2 days (Monday)
    if (day === 6) {
      date.setDate(date.getDate() + 2);
    }
    // If Sunday, add 1 day (Monday)
    else if (day === 0) {
      date.setDate(date.getDate() + 1);
    }
  }

  // Convert back to IST format
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const HH = String(date.getHours()).padStart(2, '0');
  const mmStr = String(date.getMinutes()).padStart(2, '0');

  return `${yyyy}-${MM}-${dd}T${HH}:${mmStr}:00`;
}

function isValidAuctionWindow(start, end) {
    return start && end && start.getTime() < end.getTime();
} 

export const raSchedulerForBuyer = async (rfqNumber, req, products) => {
    const { ra_start_date, ra_end_date, contact_number, response_email, contact_name, project_id } = req.body;

    const startDate = parseISTDate(ra_start_date);
    const endDate = parseISTDate(ra_end_date);

    // Adjust the dates to avoid weekend triggers - keep in IST format
    const adjustedStartDate = adjustISTDateForWeekend(startDate, 'start');
    const adjustedEndDate = adjustISTDateForWeekend(endDate, 'end');

    const productArray = products.map(product => ({
        product_name: product.name,
    }));

    let project_name = '';
    
    if (project_id && !isNaN(project_id) && Number(project_id) !== -1) {
        const result = await rfqModel.findOne("tbl_projects", { id: Number(project_id) });
        if (result) {
            project_name = result.name;
        }
    }

    // Start email to buyer - pass IST time directly
    await createSchedule({
        rfqId: rfqNumber,
        type: 'auctionStartBuyer',
        scheduledTimeIST: adjustedStartDate,
        payload: {
            buyer_name: contact_name,
            buyer_email: response_email,
            contact_number: contact_number,
            product_name: productArray,
            project_name: project_name ?? "NA"
        }
    });

    // End email to buyer - pass IST time directly
    await createSchedule({
        rfqId: rfqNumber,
        type: 'auctionEndBuyer',
        scheduledTimeIST: adjustedEndDate,
        payload: {
            buyer_name: contact_name,
            buyer_email: response_email,
            contact_number: contact_number,
            product_name: productArray,
            project_name: project_name ?? "NA"
        }
    });
};

// Helper functions for weekend handling
function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

function getPreviousFridayIST(istDateString) {
    const date = createDateFromIST(istDateString);
    const daysToSubtract = (date.getDay() + 2) % 7; // Calculate days to subtract to get to Friday
    date.setDate(date.getDate() - daysToSubtract);
    date.setHours(17, 0, 0, 0); // Set to 5 PM Friday
    
    // Convert back to IST format
    const yyyy = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const HH = String(date.getHours()).padStart(2, '0');
    const mmStr = String(date.getMinutes()).padStart(2, '0');
    
    return `${yyyy}-${MM}-${dd}T${HH}:${mmStr}:00`;
}

function getNextMondayIST(istDateString) {
    const date = createDateFromIST(istDateString);
    const daysToAdd = (8 - date.getDay()) % 7; // Calculate days to add to get to Monday
    date.setDate(date.getDate() + daysToAdd);
    date.setHours(9, 0, 0, 0); // Set to 9 AM Monday
    
    // Convert back to IST format
    const yyyy = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const HH = String(date.getHours()).padStart(2, '0');
    const mmStr = String(date.getMinutes()).padStart(2, '0');
    
    return `${yyyy}-${MM}-${dd}T${HH}:${mmStr}:00`;
}

function addDaysToISTDate(istDateString, days) {
    const date = createDateFromIST(istDateString);
    date.setDate(date.getDate() + days);
    
    // Convert back to IST format
    const yyyy = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const HH = String(date.getHours()).padStart(2, '0');
    const mmStr = String(date.getMinutes()).padStart(2, '0');
    
    return `${yyyy}-${MM}-${dd}T${HH}:${mmStr}:00`;
}

function getMidPointISTDate(startIST, endIST) {
    const startDate = createDateFromIST(startIST);
    const endDate = createDateFromIST(endIST);
    
    const midTime = new Date(startDate.getTime() + (endDate.getTime() - startDate.getTime()) / 2);
    
    // Convert back to IST format
    const yyyy = midTime.getFullYear();
    const MM = String(midTime.getMonth() + 1).padStart(2, '0');
    const dd = String(midTime.getDate()).padStart(2, '0');
    const HH = String(midTime.getHours()).padStart(2, '0');
    const mmStr = String(midTime.getMinutes()).padStart(2, '0');
    
    return `${yyyy}-${MM}-${dd}T${HH}:${mmStr}:00`;
}

export const raSchedulerForVendor = async (req, rfqNumber, productVendormap) => {
    console.log("Reverse Auction Scheduler is running...");

    const { ra_start_date, ra_end_date, company_name } = req.body;

    // Validate required parameters
    if (!ra_start_date || !ra_end_date) {
        throw new Error('Missing required auction dates');
    }

    if (!productVendormap || Object.keys(productVendormap).length === 0) {
        throw new Error('No vendor data provided');
    }

    const vendorPayloadList = [];

    try {
        for (const vendor of Object.values(productVendormap)) {
            // Validate vendor structure
            if (!vendor?.vendorDetails?.user_id) {
                console.warn('⚠️ Skipping vendor with missing user_id:', vendor);
                continue;
            }

            const spocList = await vendorModel.getSpocDetails(vendor.vendorDetails.user_id);
            const token = await rfqModel.getVendorRfqToken(vendor.vendorDetails.user_id, rfqNumber);

            console.log("logging here the console data and spoc list here", token, spocList);

            const vendorObject = {
                vendorDetails: {
                    vendor_name: vendor.vendorDetails.name,
                    vendor_email: vendor.vendorDetails.email,
                    vendor_mobile: vendor.vendorDetails.mobile,
                    organization_name: vendor.vendorDetails.organization_name,
                },
                products: vendor.products || [],
                spocList: spocList || [],
                token,
                rfq_id: rfqNumber,
                vendor_id: vendor.vendorDetails.user_id,
                buyer_company_name: company_name || "N/A"
            };

            vendorPayloadList.push(vendorObject);
            console.log("✅ Vendor Object processed:", vendorObject.vendorDetails.vendor_name);
        }

        // Schedule emails for each vendor
        for (const vendorPayload of vendorPayloadList) {
            try {
                await scheduleEmailsForAuctionEventBridge(
                    vendorPayload,
                    ra_start_date,
                    ra_end_date
                );
            } catch (error) {
                console.error(`❌ Failed to schedule emails for vendor ${vendorPayload.vendorDetails.vendor_name}:`, error.message);
            }
        }

        return vendorPayloadList;
    } catch (error) {
        console.error("❌ Error in raSchedulerForVendor:", error.message);
        throw error;
    }
};

export async function scheduleEmailsForAuctionEventBridge(
    vendorPayload,
    ra_start_date,
    ra_end_date
) {
    // Extract vendor details with proper fallbacks
    const {
        vendorDetails: {
            vendor_email,
            vendor_name,
            vendor_mobile,
            organization_name
        } = {},
        products = [],
        spocList = [],
        token = '',
        rfq_id,
        vendor_id,
        buyer_company_name
    } = vendorPayload;

    // Validate required fields
    if (!vendor_email || !vendor_name || !rfq_id || !vendor_id || !buyer_company_name) {
        throw new Error('Missing required vendor information');
    }

    const now = new Date();

    try {
        // Parse IST dates and keep them in IST format
        const startDateIST = parseISTDate(ra_start_date);
        const endDateIST = parseISTDate(ra_end_date);
        
        // Create Date objects for validation only
        const startDate = createDateFromIST(startDateIST);
        const endDate = createDateFromIST(endDateIST);
        
        console.log("Start Date IST:", startDateIST, "End Date IST:", endDateIST);

        // Validate dates
        if (endDate <= startDate) {
            throw new Error('Auction end date must be after start date');
        }
        if (startDate <= now) {
            throw new Error('Auction start date must be in the future');
        }

        console.log(`📧 Scheduling emails for vendor: ${vendor_name} (${vendor_email})`);

        // === 1. One-Day-Before Email ===
        const oneDayBeforeIST = addDaysToISTDate(startDateIST, -1);
        const oneDayBeforeDate = createDateFromIST(oneDayBeforeIST);
        oneDayBeforeDate.setHours(9, 0, 0, 0); // Set to 9 AM
        
        // Convert back to IST format with adjusted time
        const yyyy = oneDayBeforeDate.getFullYear();
        const MM = String(oneDayBeforeDate.getMonth() + 1).padStart(2, '0');
        const dd = String(oneDayBeforeDate.getDate()).padStart(2, '0');
        let oneDayBeforeAdjusted = `${yyyy}-${MM}-${dd}T09:00:00`;
        
        let oneDayBeforeScheduleIST = isWeekend(oneDayBeforeDate)
            ? getPreviousFridayIST(oneDayBeforeAdjusted)
            : oneDayBeforeAdjusted;

        console.log("One day before schedule time check ------>", oneDayBeforeScheduleIST);

        if (createDateFromIST(oneDayBeforeScheduleIST) > now) {
            await createSchedule({
                rfqId: rfq_id,
                type: 'oneDayBeforeAuctionVendor',
                vendor_id,
                scheduledTimeIST: oneDayBeforeScheduleIST,
                payload: {
                    vendor_email,
                    vendor_name,
                    vendor_mobile,
                    products,
                    organization_name,
                    start_date: startDateIST,
                    spocList,
                    token,
                    rfqId: rfq_id,
                    buyer_company_name
                }
            });
            console.log(`✅ Scheduled one-day-before email for ${vendor_name}`);
        } else {
            console.log(`⏭️ Skipped one-day-before email for ${vendor_name} - date already passed`);
        }

        // === 2. Auction Start Email ===
        let auctionStartScheduleIST = isWeekend(startDate)
            ? getPreviousFridayIST(startDateIST)
            : startDateIST;
            
        console.log("Auction start schedule:", auctionStartScheduleIST);
        
        if (createDateFromIST(auctionStartScheduleIST) >= now) {
            await createSchedule({
                rfqId: rfq_id,
                type: 'auctionStartVendor',
                vendor_id,
                scheduledTimeIST: auctionStartScheduleIST,
                payload: {
                    vendor_email,
                    vendor_name,
                    vendor_mobile,
                    products,
                    organization_name,
                    start_date: startDateIST,
                    spocList,
                    token,
                    rfqId: rfq_id,
                    buyer_company_name
                },
            });
            console.log(`✅ Scheduled auction-start email for vendor ${vendor_name}`);
        } else {
            console.log(`⏭️ Skipped auction-start emails - date already passed`);
        }

        // === 3. Mid Auction Reminder Email ===
        const midAuctionTimeIST = getMidPointISTDate(startDateIST, endDateIST);
        const midAuctionDate = createDateFromIST(midAuctionTimeIST);
        
        const midAuctionScheduleIST = isWeekend(midAuctionDate)
            ? getNextMondayIST(midAuctionTimeIST)
            : midAuctionTimeIST;
            
        console.log("Mid auction schedule time check:", midAuctionScheduleIST);

        if (createDateFromIST(midAuctionScheduleIST) >= now) {
            await createSchedule({
                rfqId: rfq_id,
                type: 'midAuctionReminderVendor',
                vendor_id,
                scheduledTimeIST: midAuctionScheduleIST,
                payload: {
                    vendor_email,
                    vendor_name,
                    vendor_mobile,
                    products,
                    organization_name,
                    end_date: endDateIST,
                    spocList,
                    token,
                    rfqId: rfq_id,
                    buyer_company_name
                },
            });
            console.log(`✅ Scheduled mid-auction reminder for vendor ${vendor_name}`);
        }

        // === 4. Auction End Email ===
        const auctionEndScheduleIST = isWeekend(endDate)
            ? getNextMondayIST(endDateIST)
            : endDateIST;
            
        console.log("Auction end schedule:", auctionEndScheduleIST);

        await createSchedule({
            rfqId: rfq_id,
            type: 'auctionEndVendor',
            vendor_id,
            scheduledTimeIST: auctionEndScheduleIST,
            payload: {
                vendor_email,
                vendor_name,
                vendor_mobile,
                products,
                organization_name,
                end_date: endDateIST,
                spocList,
                token,
                rfqId: rfq_id,
                buyer_company_name
            },
        });
        console.log(`✅ Scheduled auction-end email for vendor ${vendor_name}`);

        console.log(`✅ Successfully scheduled all applicable emails for RFQ ${rfq_id}, Vendor: ${vendor_name}`);

        return {
            success: true,
            vendor: vendor_name,
            scheduledEmails: {
                oneDayBefore: createDateFromIST(oneDayBeforeScheduleIST) > now,
                auctionStart: createDateFromIST(auctionStartScheduleIST) >= now,
                midAuction: createDateFromIST(midAuctionScheduleIST) >= now,
                auctionEnd: true
            }
        };

    } catch (error) {
        console.error(`❌ Failed to schedule emails for vendor ${vendor_name}: ${error.message}`);
        throw error;
    }
}