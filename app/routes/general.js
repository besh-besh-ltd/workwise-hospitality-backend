import { Router } from 'express';

import generalController from '../controllers/general/generalController.js';


const GeneralRoutes = Router();
 

GeneralRoutes.get(
  '/states',
  generalController.getStates
);
GeneralRoutes.get(
    '/cities/:id',
    generalController.getCities
  );



export default GeneralRoutes;
