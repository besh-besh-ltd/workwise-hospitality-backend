

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

// Add this utility function at the top of your file
function parseISTDate(datetimeStr) {
  console.log("Parsing date string:", datetimeStr);
  
  // Handle cases where time might be missing
  if (!datetimeStr.includes(' ')) {
    datetimeStr += ' 00:00';  // Default to midnight
  }

  const cleaned = datetimeStr.trim().replace(/\s+/g, ' ');
  const [datePart, timePart] = cleaned.split(' ');
  
  if (!datePart || !timePart) {
    throw new Error(`Invalid date format: ${datetimeStr}`);
  }

  // Extract components
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);

  // Validate components
  if (
    isNaN(year) || isNaN(month) || isNaN(day) ||
    isNaN(hours) || isNaN(minutes)
  ) {
    throw new Error(`Invalid date components: ${datetimeStr}`);
  }

  // Create date in UTC equivalent to IST (IST = UTC+5:30)
  const date = new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30));

  // Validate final date
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${datetimeStr}`);
  }

  console.log("Parsed UTC date:", date.toISOString());
  return date;
}

function isValidAuctionWindow(start, end) {
    return start && end && start.getTime() < end.getTime();
} 


function adjustDateForWeekend(originalDate, type) {
  const date = new Date(originalDate); // assume this is in ISO format
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

  return date.toISOString(); // return in same ISO format
}


export const raSchedulerForBuyer = async (rfqNumber,req, products) => {
  
    const { ra_start_date, ra_end_date ,contact_number , response_email,contact_name,project_id} = req.body;

        // Adjust the dates to avoid weekend triggers
    const adjustedStartDate = adjustDateForWeekend(startDate, 'start');
    const adjustedEndDate = adjustDateForWeekend(endDate, 'end');

    const productArray = products.map(product => ({
        product_name: product.name,
    })
)
    const startDate = parseISTDate(ra_start_date);

    const endDate = parseISTDate(ra_end_date);

    let project_name = '';
    let whereClause = ' where id = ?';
     // Log final dates being sent to createSchedule
    


    if (project_id && !isNaN(project_id) && Number(project_id) !== -1) {
  const result = await rfqModel.findOne("tbl_projects", { id: Number(project_id) });
  if (result) {
    project_name = result.name;
  }
}



    // Start email to buyer
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




    // End email to buyer
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


 // Helper functions (assuming these exist elsewhere in your codebase)
function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

function getPreviousFriday(date) {
  const friday = new Date(date);
  const daysToSubtract = (date.getDay() + 2) % 7; // Calculate days to subtract to get to Friday
  friday.setDate(date.getDate() - daysToSubtract);
  friday.setHours(17, 0, 0, 0); // Set to 5 PM Friday
  return friday;
}
 
function getNextMonday(date) {
  const monday = new Date(date);
  const daysToAdd = (8 - date.getDay()) % 7; // Calculate days to add to get to Monday
  monday.setDate(date.getDate() + daysToAdd);
  monday.setHours(9, 0, 0, 0); // Set to 9 AM Monday
  return monday;
}

export const raSchedulerForVendor = async (req, rfqNumber, productVendormap) => {
  console.log("Reverse Auction Scheduler is running...");

  const { ra_start_date, ra_end_date , company_name } = req.body;

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

      console.log("logging here the console data and spoc list here", token ,spocList);

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
        rfq_id: rfqNumber, // Add rfq_id for downstream use
        vendor_id: vendor.vendorDetails.user_id, // Add vendor_id
        buyer_company_name : company_name
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
    buyer_company_name  // This is the buyer's company name
  } = vendorPayload;

  // Validate required fields
  if (!vendor_email || !vendor_name || !rfq_id || !vendor_id || !buyer_company_name) {
    throw new Error('Missing required vendor information');
  }

  const now = new Date();

  try {
    const startDate = new Date(ra_start_date);
    const endDate = new Date(ra_end_date);

    // Validate dates
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error('Invalid date format');
    }
    if (endDate <= startDate) {
      throw new Error('Auction end date must be after start date');
    }
    if (startDate <= now) {
      throw new Error('Auction start date must be in the future');
    }

    console.log(`📧 Scheduling emails for vendor: ${vendor_name} (${vendor_email})`);

    // === 1. One-Day-Before Email ===
    const oneDayBefore = new Date(startDate);
    oneDayBefore.setDate(startDate.getDate() - 1);
    oneDayBefore.setHours(9, 0, 0, 0); // Set to 9 AM
    
    let oneDayBeforeSchedule = isWeekend(oneDayBefore)
      ? getPreviousFriday(oneDayBefore)
      : oneDayBefore;

    if (oneDayBeforeSchedule > now) {
      await createSchedule({
        rfqId: rfq_id,
        type: 'oneDayBeforeAuctionVendor',
        vendor_id,
        scheduledTimeIST: oneDayBeforeSchedule.toISOString(),
        payload: {
          vendor_email,
          vendor_name,
          vendor_mobile,
          products,
          organization_name,
          start_date: parseISTDate(ra_start_date),
          spocList,
          token,
          rfqId: rfq_id,
          buyer_company_name  // Corrected here
        }
      });
      console.log(`✅ Scheduled one-day-before email for ${vendor_name}`);
    } else {
      console.log(`⏭️ Skipped one-day-before email for ${vendor_name} - date already passed`);
    }

    // === 2. Auction Start Email ===
    let auctionStartSchedule = isWeekend(startDate)
      ? getPreviousFriday(startDate)
      : startDate;

    if (auctionStartSchedule >= now) {
      // Vendor start email
      await createSchedule({
        rfqId: rfq_id,
        type: 'auctionStartVendor',
        vendor_id,
        scheduledTimeIST: auctionStartSchedule.toISOString(),
        payload: {
          vendor_email,
          vendor_name,
          vendor_mobile,
          products,
          organization_name,
          start_date: parseISTDate(ra_start_date),
          spocList,
          token,
          rfqId: rfq_id,
          buyer_company_name  // Corrected here
        },
      });
      console.log(`✅ Scheduled auction-start email for vendor ${vendor_name}`);
    } else {
      console.log(`⏭️ Skipped auction-start emails - date already passed`);
    }

    // === 3. Mid Auction Reminder Email ===
    const auctionDuration = endDate.getTime() - startDate.getTime();
    const midAuctionTime = new Date(startDate.getTime() + auctionDuration / 2);
    
    const midAuctionSchedule = isWeekend(midAuctionTime)
      ? getNextMonday(midAuctionTime)
      : midAuctionTime;

    // Schedule mid-auction email
    if (midAuctionSchedule >= now) {
      await createSchedule({
        rfqId: rfq_id,
        type: 'midAuctionReminderVendor',
        vendor_id,
        scheduledTimeIST: midAuctionSchedule.toISOString(),
        payload: {
          vendor_email,
          vendor_name,
          vendor_mobile,
          products,
          organization_name,
          end_date: parseISTDate(ra_end_date),
          spocList,
          token,
          rfqId: rfq_id,
          buyer_company_name  // Corrected here (was missing)
        },
      });
      console.log(`✅ Scheduled mid-auction reminder for vendor ${vendor_name}`);
    }

    // === 4. Auction End Email ===
    const auctionEndSchedule = isWeekend(endDate)
      ? getNextMonday(endDate)
      : endDate;

    // Vendor end email
    await createSchedule({
      rfqId: rfq_id,
      type: 'auctionEndVendor',
      vendor_id,
      scheduledTimeIST: auctionEndSchedule.toISOString(),
      payload: {
        vendor_email,
        vendor_name,
        vendor_mobile,
        products,
        organization_name,
        end_date: parseISTDate(ra_end_date),
        spocList,
        token,
        rfqId: rfq_id,
        buyer_company_name  // Corrected here
      },
    });
    console.log(`✅ Scheduled auction-end email for vendor ${vendor_name}`);

    console.log(`✅ Successfully scheduled all applicable emails for RFQ ${rfq_id}, Vendor: ${vendor_name}`);
    
    return {
      success: true,
      vendor: vendor_name,
      scheduledEmails: {
        oneDayBefore: oneDayBeforeSchedule > now,
        auctionStart: auctionStartSchedule >= now,
        midAuction: midAuctionSchedule >= now,
        auctionEnd: true
      }
    };

  } catch (error) {
    console.error(`❌ Failed to schedule emails for vendor ${vendor_name}: ${error.message}`);
    throw error;
  }
}