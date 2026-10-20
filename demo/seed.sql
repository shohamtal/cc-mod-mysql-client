-- Dummy data for the README screenshots. Nothing here is real.
CREATE DATABASE IF NOT EXISTS shop;
CREATE DATABASE IF NOT EXISTS analytics;
USE shop;
CREATE TABLE customers (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80), email VARCHAR(120), country CHAR(2), created_at DATETIME);
CREATE TABLE products (id INT PRIMARY KEY AUTO_INCREMENT, sku VARCHAR(20), title VARCHAR(120), category VARCHAR(40), price DECIMAL(8,2), stock INT);
CREATE TABLE orders (id INT PRIMARY KEY AUTO_INCREMENT, customer_id INT, product_id INT, qty INT, status ENUM('new','paid','shipped','refunded'), total DECIMAL(10,2), ordered_at DATETIME);
INSERT INTO customers (name, email, country, created_at) VALUES
 ('Ada Example','ada@example.com','GB','2026-01-04 09:12:00'),('Bo Sample','bo@example.org','SE','2026-02-11 14:30:00'),
 ('Chen Demo','chen@example.net','SG','2026-03-02 08:01:00'),('Dana Test','dana@example.com','US','2026-03-19 17:45:00'),
 ('Eli Mock','eli@example.org','IL','2026-04-08 11:20:00'),('Fay Fixture','fay@example.com','DE','2026-05-23 10:05:00'),
 ('Gus Dummy','gus@example.net','BR','2026-06-14 19:40:00'),('Hana Stub','hana@example.com','JP','2026-07-30 07:55:00');
INSERT INTO products (sku, title, category, price, stock) VALUES
 ('SH-100','Trail runner','shoes',89.00,42),('SH-210','Road racer','shoes',129.00,17),('SH-305','Kids sneaker','shoes',45.50,88),
 ('AP-010','Rain jacket','apparel',74.90,23),('AP-022','Merino tee','apparel',39.00,0),('AC-501','Water bottle','accessories',12.00,310),
 ('AC-530','Running belt','accessories',18.50,64);
INSERT INTO orders (customer_id, product_id, qty, status, total, ordered_at) VALUES
 (1,1,1,'shipped',89.00,'2026-09-01 10:00:00'),(2,4,2,'paid',149.80,'2026-09-03 12:10:00'),(3,2,1,'shipped',129.00,'2026-09-05 09:30:00'),
 (4,6,4,'new',48.00,'2026-09-08 16:45:00'),(5,1,2,'refunded',178.00,'2026-09-10 08:20:00'),(1,7,1,'paid',18.50,'2026-09-12 13:00:00'),
 (6,3,3,'shipped',136.50,'2026-09-15 15:15:00'),(7,5,1,'new',39.00,'2026-09-18 11:11:00'),(8,2,1,'paid',129.00,'2026-09-21 18:05:00'),
 (2,6,6,'shipped',72.00,'2026-09-24 07:40:00'),(3,4,1,'paid',74.90,'2026-09-27 20:30:00'),(4,1,1,'shipped',89.00,'2026-10-01 09:05:00');
USE analytics;
CREATE TABLE daily_sales (day DATE PRIMARY KEY, orders INT, revenue DECIMAL(10,2));
INSERT INTO daily_sales VALUES ('2026-10-01',14,1290.50),('2026-10-02',9,811.00),('2026-10-03',17,1544.20);
CREATE USER 'demo'@'%' IDENTIFIED BY 'demo-only-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'demo'@'%';
GRANT SELECT ON analytics.* TO 'demo'@'%';
