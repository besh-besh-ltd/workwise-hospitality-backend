import { Router } from 'express';

import generalController from '../controllers/general/generalController.js';


const GeneralRoutes = Router();


GeneralRoutes.get(
  '/states',
  generalController.getStates
);
GeneralRoutes.get(
  '/cities/:id?',
  generalController.getCities
);
GeneralRoutes.get(
  '/countries',
  generalController.getCountries
);



export default GeneralRoutes;
