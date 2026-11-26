ALTER TABLE coffee_enrollments ADD COLUMN order_channel TEXT NOT NULL DEFAULT 'members' CHECK (order_channel IN ('members','shop'));
