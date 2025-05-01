import cron from 'node-cron';
import whatsappNotificationFluxChat from '../whatsappNotificationFluxChat.js';

// Helper functions (same as before)
function parseDate(dateString, timezone = 'UTC') {
    if (!dateString) return null;
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return null;
        return date;
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

function isValidAuctionWindow(start, end) {
    return start && end && start.getTime() < end.getTime();
}

function scheduleWhatsApp(cronTime, callback, notificationName, vendor) {
    try {
        const now = new Date();
        const [minute, hour, day, month] = cronTime.pattern.split(' ');
        const cronDate = new Date(Date.UTC(now.getUTCFullYear(), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute)));

        if (now > cronDate) {
            console.log(`Skipping ${notificationName} for ${vendor} (past date)`);
            return null;
        }

        const job = cron.schedule(cronTime.pattern, callback, {
            timezone: cronTime.timezone,
            scheduled: true
        });

        console.log(`Scheduled ${notificationName} for ${vendor} at ${cronTime.pattern} ${cronTime.timezone}`);
        return job;
    } catch (error) {
        console.error(`Error scheduling ${notificationName} for ${vendor}:`, error);
        return null;
    }
}

function scheduleWhatsAppForAuction(item, company_name, ra_start_date, ra_end_date, timezone = 'UTC', buyer_name = '', project_name = '', contact_number) {
    const { vendor, products, workingDays = 'Unknown' , mobile } = item;
    const jobs = [];

    try {
        if (!(ra_start_date instanceof Date)) throw new Error('Invalid start date format');
        if (!(ra_end_date instanceof Date)) throw new Error('Invalid end date format');
        if (!isValidAuctionWindow(ra_start_date, ra_end_date)) {
            throw new Error('Auction end date must be after start date');
        }

        const oneDayBefore = new Date(ra_start_date);
        oneDayBefore.setDate(oneDayBefore.getDate() - 1);

        const auctionStartDay = ra_start_date.getUTCDay();
        const auctionDurationMs = ra_end_date.getTime() - ra_start_date.getTime();
        const midAuction = new Date(ra_start_date.getTime() + (auctionDurationMs / 2));

        // --- "1 Day Before" WhatsApp Notification ---
        if (auctionStartDay === 1) { 
            const fridayBefore = new Date(ra_start_date);
            fridayBefore.setUTCDate(ra_start_date.getUTCDate() - 3);

            const saturdayBefore = new Date(ra_start_date);
            saturdayBefore.setUTCDate(ra_start_date.getUTCDate() - 2);

            jobs.push(
                scheduleWhatsApp(
                    createCronString(fridayBefore, timezone),
                    () => {
                        const oneDayBeforeNotification = {
                            mobile,
                            vendor,
                            productName,
                            buyerCompanyName:company_name,
                            startTime :formatDate(ra_start_date)
                            
                        };
                        whatsappNotificationFluxChat.oneDayBeforeAuctionNotificationToVendor(oneDayBeforeNotification);
                        console.log(`Sent 1-day-before (Friday fallback) WhatsApp to ${vendor}`);
                    },
                    'One-Day-Before WhatsApp (Friday fallback)',
                    vendor
                )
            );

            jobs.push(
                scheduleWhatsApp(
                    createCronString(saturdayBefore, timezone),
                    () => {
                        const oneDayBeforeNotification = {
                            mobile,
                            vendor,
                            productName,
                            buyerCompanyName:company_name,
                            startTime :formatDate(ra_start_date)
                        };
                        whatsappNotificationFluxChat.oneDayBeforeAuctionNotificationToVendor(oneDayBeforeNotification);
                        console.log(`Sent 1-day-before (Saturday fallback) WhatsApp to ${vendor}`);
                    },
                    'One-Day-Before WhatsApp (Saturday fallback)',
                    vendor
                )
            );
        } else {
            jobs.push(
                scheduleWhatsApp(
                    createCronString(oneDayBefore, timezone),
                    () => {
                        const oneDayBeforeNotification = {
                            mobile,
                            vendor,
                            productName,
                            buyerCompanyName:company_name,
                            startTime :formatDate(ra_start_date)
                        };
                        whatsappNotificationFluxChat.oneDayBeforeAuctionNotificationToVendor(oneDayBeforeNotification);
                        console.log(`Sent 1-day-before WhatsApp to ${vendor}`);
                    },
                    'One-Day-Before WhatsApp',
                    vendor
                )
            );
        }

        // --- Auction Start WhatsApp to Vendor ---
        jobs.push(
            scheduleWhatsApp(
                createCronString(ra_start_date, timezone),
                () => {
                    const auctionStartNotification = {
                        mobile,
                        vendor,
                        productName,
                        buyerCompanyName:company_name,
                        endTime :formatDate(ra_end_date)
                    };
                    whatsappNotificationFluxChat.auctionLiveNotificationToVendor(auctionStartNotification);
                    
                    console.log(`Sent auction-start WhatsApp to ${vendor}`);
                },
                'Auction Start WhatsApp',
                vendor
            )
        );

        // --- Auction Start WhatsApp to Buyer ---
        if (buyer_name && project_name) {
            jobs.push(
                scheduleWhatsApp(
                    createCronString(ra_start_date, timezone),
                    () => {
                        const auctionStartBuyerNotification = {
                            mobile:contact_number,
                            product_name: products[0]?.product_name || 'Product',
                            project_name,
                            buyer_name
                        };
                        whatsappNotificationFluxChat.auctionStartedBuyerNotification(auctionStartBuyerNotification);
                        
                        console.log(`Sent auction-start WhatsApp to Buyer: ${buyer_name}`);
                    },
                    'Auction Start WhatsApp (Buyer)',
                    buyer_name
                )
            );
        }

        // --- Mid-Auction Reminder WhatsApp to Vendor ---
        jobs.push(
            scheduleWhatsApp(
                createCronString(midAuction, timezone),
                () => {
                    const midAuctionReminder = {
                        mobile,
                        vendor,
                        productName : products,
                        buyerCompanyName : company_name
                    };
                    whatsappNotificationFluxChat.halfwayAuctionReminderNotificationToVendor(midAuctionReminder);
                    
                    console.log(`Sent mid-auction WhatsApp reminder to ${vendor}`);
                },
                'Mid-Auction Reminder WhatsApp',
                vendor
            )
        );

        // --- Auction End WhatsApp to Vendor ---
        jobs.push(
            scheduleWhatsApp(
                createCronString(ra_end_date, timezone),
                () => {
                    const auctionEndNotification = {
                        mobile,
                        vendor,
                        productName : products,
                        buyerCompanyName : company_name,
                        endTime : formatDate(ra_end_date)
                    };
                    whatsappNotificationFluxChat.auctionEndedVendorNotificationToVendor(auctionEndNotification);
                    
                    console.log(`Sent auction-end WhatsApp to ${vendor}`);
                },
                'Auction End WhatsApp',
                vendor
            )
        );

        // --- Auction End WhatsApp to Buyer ---
        if (buyer_name) {
            jobs.push(
                scheduleWhatsApp(
                    createCronString(ra_end_date, timezone),
                    () => {
                        const auctionEndBuyerNotification = {
                            mobile : contact_number,
                            buyerName : buyer_name,
                            productName : products[0]?.product_name || 'Product'
                        };
                        whatsappNotificationFluxChat.auctionEndedBuyerNotification(auctionEndBuyerNotification);
                        
                        console.log(`Sent auction-end WhatsApp to Buyer: ${buyer_name}`);
                    },
                    'Auction End WhatsApp (Buyer)',
                    buyer_name
                )
            );
        }

        return jobs.filter(job => job !== null);
    } catch (error) {
        console.error(`Error scheduling WhatsApp notifications for ${vendor}: ${error.message}`);
        return [];
    }
}

export function setupReverseAuctionWhatsAppNotifications(finalArray, company_name, reverse_auction, ra_start_date, ra_end_date, bid_end_date, timezone = 'UTC', buyer_name = '', project_name = '') {
    if (reverse_auction != 1) {
        console.log("Reverse auction disabled - no WhatsApp notifications scheduled");
        return [];
    }

    try {
        const startDate = parseDate(ra_start_date) || new Date();
        const endDate = parseDate(ra_end_date) || parseDate(bid_end_date);

        if (!endDate) throw new Error('Missing valid auction end date');
        if (!isValidAuctionWindow(startDate, endDate)) throw new Error('Invalid auction time window');

        try {
            new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        } catch (error) {
            console.warn(`Invalid timezone '${timezone}', falling back to UTC`);
            timezone = 'UTC';
        }

        return finalArray.flatMap(item => 
            scheduleWhatsAppForAuction(
                item, 
                company_name, 
                startDate, 
                endDate, 
                timezone,
                buyer_name,
                project_name
            )
        );
    } catch (error) {
        console.error('Failed to setup WhatsApp auction notifications:', error.message);
        return [];
    }
}
