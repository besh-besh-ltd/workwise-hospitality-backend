import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import generalModel from '../../models/generalModel.js';
import { AVAILABLE_HIERARCHY_TYPES } from '../../util/constants.js';

const generalController = {
  getStates: async (req, res, next) => {
    try {
      const country_id = req.query.country_id;

      let states;
      if (country_id) {
        // Convert country_id to integer (optional, based on your DB setup)
        states = await generalModel.getCountryStates(country_id);
      } else {
        states = await generalModel.getStates();
      }

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
      console.log(error);
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
  getCountries: async (req, res, next) => {
    // const state_id = req.params.id;
    try {
      const cities = await generalModel.getCountries();
      res
        .status(200)
        .json({
          status: 1,
          data: cities
        })
        .end();
    } catch (error) {
      console.log(error);
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
  getCountryCodes: async (req, res, next) => {
    try {
      const countr_codes = await generalModel.getCountryCode();
      res.status(200).json({
        status: 1,
        data: countr_codes
      });
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
  getHierarchies: async (req, res) => {
    try {
      const { type } = req.query;
      const { company_id } = req.user;

      if (type && !AVAILABLE_HIERARCHY_TYPES[type]) {
        return res.status(400).json({
          status: 2,
          message: `Provided hierarchy type \`${type}\` is not supported!`
        });
      }

      const hierarchies = await generalModel.getHierarchies(type, company_id);
      return res.json({
        status: 1,
        data: hierarchies
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      });
    }
  },
  createHierarchy: async (req, res) => {
    try {
      const { type, approvers } = req.body;
      const { company_id } = req.user;

      const doesExist = await generalModel.doesHierarchyExist(type, company_id, approvers[0]);
      if (doesExist) {
        return res.status(400).json({
          status: 2,
          message: `A Hierarchy already exist for type \`${type}\` with given initial user!`
        });
      }

      const createdHierarchy = await generalModel.createHierarchy(
        type,
        approvers,
        company_id
      );
      if (createdHierarchy) return res.status(201).end();

      return res.status(400).json({
        status: 3,
        message:
          'Something went wrong while saving the hierarchy in the database, please try again!'
      });
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({
          status: 3,
          message: error.message ?? Config.errorText.value,
          error
        })
        .end();
    }
  },
  updateHierarchy: async (req, res) => {
    try {
      const { hierarchy_id, type, approvers, removableApprovers } = req.body;
      const { company_id } = req.user;

      const updated = await generalModel.updateHierarchy(
        type,
        approvers,
        removableApprovers,
        company_id,
        hierarchy_id
      );

      if (updated) return res.status(200).end();

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while updating the hierarchy.'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  },
  mapHierarchyToProject: async (req, res) => {
    try {
      const { hierarchy_id, hierarchy_type, project_id } = req.body;
      const { id, company_id } = req.user;

      const updated = await generalModel.mapHierarchyToProject(
        hierarchy_id,
        hierarchy_type,
        project_id,
        company_id,
        id
      );

      if (updated) return res.status(200).end();

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while mapping hierarchy to project'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  },
  setDefaultHierarchy: async (req, res) => {
    try {
      const { hierarchy_id, hierarchy_type } = req.body;
      const { id, company_id } = req.user;

      const updated = await generalModel.setDefaultHierarchy(
        hierarchy_id,
        hierarchy_type,
        company_id,
        id
      );

      if (updated) return res.status(200).end();

      return res.status(400).json({
        status: 3,
        message: 'Something went wrong while setting hierarchy as default'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message ?? Config.errorText.value,
        error
      }).end();
    }
  }
};
export default generalController;
