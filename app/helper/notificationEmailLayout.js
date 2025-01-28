function generateEmailTemplate(headerContent, containerContent) {
    return `
        <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; background-color: #ffe4e4eb; width: 100%; max-width: 768px; border-radius: 20px; margin: 0 auto; padding: 40px; box-sizing: border-box;">
            <div>
                <img style="width: 200px; mix-blend-mode: multiply; margin-left: -18px;" src="https://letsworkwise.com/assets/images/logo.png" alt="workwise-Logo" />
                <p style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; font-size: 16px; font-weight: 600; color: #333333; margin-top: -7px;">
                    Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
                    Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063
                </p>
            </div>

            <hr />

            ${headerContent}
            
            <div style="border-radius: 24px; padding: 32px 16px; margin-bottom: 24px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                ${containerContent}
            </div>
            
            <hr />
            
            <p style="font-size: 16px;">If you need assistance, contact us at <a href="mailto:hello@letsworkwise.com">hello@letsworkwise.com</a></p>
            <p style="font-size: 16px;">© WorkWise. All Rights Reserved.</p>
        </div>
    `;
}


export { generateEmailTemplate }