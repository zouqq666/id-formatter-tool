-- schema.sql - ID formatter stats database schema
-- For TiDB Cloud Serverless (MySQL compatible)
-- Tables are auto-created by main.ts ensureTables() on first request
-- This file is for manual reference / verification

-- Stats key-value table (counters)
CREATE TABLE IF NOT EXISTS stats (
  stat_key VARCHAR(50) PRIMARY KEY,
  stat_value BIGINT NOT NULL DEFAULT 0
);

-- All-time unique users
CREATE TABLE IF NOT EXISTS all_users (
  user_id VARCHAR(100) PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Daily unique users (for today's user count)
CREATE TABLE IF NOT EXISTS daily_users (
  stat_date VARCHAR(10) NOT NULL,
  user_id VARCHAR(100) NOT NULL,
  PRIMARY KEY (stat_date, user_id)
);

-- Visitor location distribution
CREATE TABLE IF NOT EXISTS locations (
  province VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL,
  visit_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (province, city)
);

-- IP to location cache (avoid repeated ipapi.co calls)
CREATE TABLE IF NOT EXISTS ip_cache (
  ip VARCHAR(50) PRIMARY KEY,
  province VARCHAR(100),
  city VARCHAR(100)
);

-- Insert initial stat keys
INSERT IGNORE INTO stats (stat_key, stat_value) VALUES
  ('totalVisits', 0),
  ('totalUsers', 0),
  ('todayVisits', 0),
  ('todayUsers', 0),
  ('lastDate', '');
