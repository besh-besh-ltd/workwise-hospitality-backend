import generalModel from '../models/generalModel.js';

export const isHoliday = async (date) => {
  try {
    const result = await generalModel.getHolidays(date); // already returns true/false
    return result;
  } catch (error) {
    console.error('Error checking holiday:', error);
    throw error;
  }
};


