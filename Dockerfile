# Sử dụng Node.js 20 bản nhẹ
FROM node:20-alpine

# Cài đặt các công cụ build cần thiết
RUN apk add --no-cache python3 make g++

# Đặt thư mục làm việc
WORKDIR /app

# Copy các file cấu hình
COPY package*.json ./

# Cài đặt production dependencies
RUN npm ci --only=production

# Dọn dẹp công cụ build để giảm dung lượng image
RUN apk del python3 make g++

# Copy toàn bộ mã nguồn
COPY . .

# Tạo thư mục temp_audio và cấp quyền
RUN mkdir -p temp_audio && chown -R node:node /app

# Chuyển sang user 'node'
USER node

# Mở cổng
EXPOSE 3000

# Khởi chạy
CMD ["npm", "start"]
