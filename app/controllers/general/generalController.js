import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import generalModel from '../../models/generalModel.js';

const generalController = {
  getStates: async (req, res, next) => {
    try {
      const states = await generalModel.getStates();
      res
        .status(200)
        .json({
          status: 1,
          data: states 
        })
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
  getCities: async (req, res, next) => {
    const state_id = req.params.id;
    try {
      const cities = await generalModel.getCities(state_id);
      res
        .status(200)
        .json({
          status: 1,
          data: cities
        })
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
  } 
};
export default generalController;
