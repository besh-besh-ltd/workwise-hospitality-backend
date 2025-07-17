import { Router } from "express";

const PORoutes = Router();

PORoutes.get('/test', (req, res) => res.json({ message: "WORKINN!!" }));

export default PORoutes;