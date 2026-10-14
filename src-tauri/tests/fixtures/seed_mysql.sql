-- Test data for tests/db_integration.rs and tests/tools_docker.rs (container rits-my, database "loja").
-- docker exec -i rits-my mysql -uroot -pbgtest --default-character-set=utf8mb4 loja < src-tauri/tests/fixtures/seed_mysql.sql
CREATE TABLE produtos (id INT AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(100) NOT NULL, preco DECIMAL(10,2), criado DATETIME DEFAULT CURRENT_TIMESTAMP) COMMENT='Catálogo';
INSERT INTO produtos (nome, preco) VALUES ('Café', 19.90), ('Chá', 9.50), ('Açúcar', 4.25);
CREATE VIEW caros AS SELECT * FROM produtos WHERE preco > 5;
DELIMITER //
CREATE PROCEDURE reajuste(IN pct DECIMAL(5,2)) BEGIN UPDATE produtos SET preco = preco * (1 + pct/100); END //
DELIMITER ;
