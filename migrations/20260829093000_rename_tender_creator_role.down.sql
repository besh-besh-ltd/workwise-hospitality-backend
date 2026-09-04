BEGIN;

UPDATE public.tbl_roles
   SET title = 'Tender Creator'
 WHERE id = 2
   AND title = 'RFQ Creator';

COMMIT;
