import cron from 'node-cron';
import {
    auctionEndEmailTemplate,
    auctionEndEmailTemplateToBuyer,
    auctionHalfWayEmailTemplate,
    auctionStartedEmailTemplate,
    auctionStartEmailTemplateToBuyer,
    oneDayBeforeEmailTemplate
} from './reverseAuctionEmails.js';

import { isHoliday } from '../holiday.js';

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

function isValidAuctionWindow(start, end) {
    return start && end && start.getTime() < end.getTime();
}

function scheduleEmail(cronTime, callback, emailName, vendor) {
    try {
        const now = new Date();
        const [minute, hour, day, month] = cronTime.pattern.split(' ');
        const cronDate = new Date(Date.UTC(now.getUTCFullYear(), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute)));

        if (now > cronDate) {
            console.log(`Skipping ${emailName} for ${vendor} (past date)`);   //review 
            return null;
        }

        const job = cron.schedule(cronTime.pattern, callback, {
            timezone: cronTime.timezone,
            scheduled: true
        });

        console.log(`Scheduled ${emailName} for ${vendor} at ${cronTime.pattern} ${cronTime.timezone}`);
        return job;
    } catch (error) {
        console.error(`Error scheduling ${emailName} for ${vendor}:`, error);
        return null;
    }
}

async function scheduleEmailsForAuction(item, company_name, ra_start_date, ra_end_date, timezone = 'UTC', buyer_name = '', project_name = '', buyer_email) {
    const { vendorEmail , vendor, products } = item;
    const jobs = [];

    try {
        if (!(ra_start_date instanceof Date) || !(ra_end_date instanceof Date)) {
            throw new Error('Invalid date format');
        }

        if (!isValidAuctionWindow(ra_start_date, ra_end_date)) {
            throw new Error('Auction end date must be after start date');
        }

        const now = new Date();
        const oneDayBefore = new Date(ra_start_date);
        oneDayBefore.setUTCDate(oneDayBefore.getUTCDate() - 1);

        const midAuction = new Date(ra_start_date.getTime() + ((ra_end_date.getTime() - ra_start_date.getTime()) / 2));

        const raDateOnly = new Date(Date.UTC(ra_start_date.getUTCFullYear(), ra_start_date.getUTCMonth(), ra_start_date.getUTCDate()));
        const oneDayBeforeOnly = new Date(Date.UTC(oneDayBefore.getUTCFullYear(), oneDayBefore.getUTCMonth(), oneDayBefore.getUTCDate()));

        const isRaHoliday = await isHoliday(raDateOnly.toISOString().slice(0, 10));


        if (isRaHoliday) {
            if (now < oneDayBefore) {
                jobs.push(
                    scheduleEmail(
                        createCronString(oneDayBefore, timezone),
                        () => {
                            oneDayBeforeEmailTemplate(vendorEmail ,vendor, products, company_name, formatDate(ra_start_date));
                            console.log(`Sent auction-start (holiday fallback) email to ${vendor}`);
                        },
                        'Auction Start Email (Holiday Fallback)',
                        vendor
                    )
                );

                if (buyer_name && project_name) {
                    jobs.push(
                        scheduleEmail(
                            createCronString(oneDayBefore, timezone),
                            () => {
                                auctionStartEmailTemplateToBuyer(buyer_email , products[0]?.product_name || 'Product', project_name, buyer_name);
                                console.log(`Sent auction-start email to Buyer: ${buyer_name} (Holiday Fallback)`);
                            },
                            'Auction Start Email (Buyer - Holiday Fallback)',
                            buyer_name
                        )
                    );
                }
            } else {
                jobs.push(
                    scheduleEmail(
                        createCronString(ra_start_date, timezone),
                        () => {
                            auctionStartedEmailTemplate(vendorEmail , vendor, products, company_name, formatDate(ra_start_date));
                            console.log(`Sent auction-start email to ${vendor}`);
                        },
                        'Auction Start Email (Holiday - Last Resort)',
                        vendor
                    )
                );

                if (buyer_name && project_name) {
                    jobs.push(
                        scheduleEmail(
                            createCronString(ra_start_date, timezone),
                            () => {
                                auctionStartEmailTemplateToBuyer(buyer_email , products[0]?.product_name || 'Product', project_name, buyer_name);
                                console.log(`Sent auction-start email to Buyer: ${buyer_name}`);
                            },
                            'Auction Start Email (Buyer)',
                            buyer_name
                        )
                    );
                }
            }
        } else {
            jobs.push(
                scheduleEmail(
                    createCronString(oneDayBefore, timezone),
                    () => {
                        oneDayBeforeEmailTemplate(vendorEmail , vendor, products, company_name, formatDate(ra_start_date));
                        console.log(`Sent 1-day-before email to ${vendor}`);
                    },
                    'One-Day-Before Email',
                    vendor
                )
            );

            jobs.push(
                scheduleEmail(
                    createCronString(ra_start_date, timezone),
                    () => {
                        auctionStartedEmailTemplate(vendorEmail , vendor, products, company_name, formatDate(ra_start_date));
                        console.log(`Sent auction-start email to ${vendor}`);
                    },
                    'Auction Start Email',
                    vendor
                )
            );

            if (buyer_name && project_name) {
                jobs.push(
                    scheduleEmail(
                        createCronString(ra_start_date, timezone),
                        () => {
                            auctionStartEmailTemplateToBuyer(buyer_email , products[0]?.product_name || 'Product', project_name, buyer_name);
                            console.log(`Sent auction-start email to Buyer: ${buyer_name}`);
                        },
                        'Auction Start Email (Buyer)',
                        buyer_name
                    )
                );
            }
        }

        // Mid-auction and end emails always scheduled if applicable
        jobs.push(
            scheduleEmail(
                createCronString(midAuction, timezone),
                () => {
                    auctionHalfWayEmailTemplate(vendorEmail , vendor, products, company_name, formatDate(ra_start_date));
                    console.log(`Sent mid-auction reminder to ${vendor}`);
                },
                'Mid-Auction Reminder',
                vendor
            )
        );

        jobs.push(
            scheduleEmail(
                createCronString(ra_end_date, timezone),
                () => {
                    auctionEndEmailTemplate(vendorEmail , vendor, products, company_name, formatDate(ra_end_date));
                    console.log(`Sent auction-end email to ${vendor}`);
                },
                'Auction End Email',
                vendor
            )
        );

        if (buyer_name) {
            jobs.push(
                scheduleEmail(
                    createCronString(ra_end_date, timezone),
                    () => {
                        auctionEndEmailTemplateToBuyer(buyer_email , buyer_name, products[0]?.product_name || 'Product');
                        console.log(`Sent auction-end email to Buyer: ${buyer_name}`);
                    },
                    'Auction End Email (Buyer)',
                    buyer_name
                )
            );
        }

        return jobs.filter(Boolean);
    } catch (error) {
        console.error(`Error scheduling emails for ${vendor}: ${error.message}`);
        return [];
    }
}

export async function setupReverseAuctionMails(finalArray, company_name, reverse_auction, ra_start_date, ra_end_date, bid_end_date, timezone = 'UTC', buyer_name = '', buyer_email, project_name = '') {
    if (reverse_auction != 1) {
        console.log("Reverse auction disabled - no emails scheduled");
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

        const allJobs = await Promise.all(
            finalArray.map(item =>
                scheduleEmailsForAuction(
                    item,
                    company_name,
                    startDate,
                    endDate,
                    timezone,
                    buyer_name,
                    project_name,
                    buyer_email
                )
            )
        );

        return allJobs.flat();
    } catch (error) {
        console.error('Failed to setup auction emails:', error.message);
        return [];
    }
}
