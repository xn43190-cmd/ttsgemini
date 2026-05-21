# Sử dụng Node.js 20 bản nhẹ, tự động nhận diện kiến trúc ARM của Armbian
FROM node:20-alpine

# Đặt thư mục làm việc trong container
WORKDIR /app

# Copy package.json và package-lock.json vào trước để tận dụng cache
COPY package*.json ./

# Cài đặt các dependencies (chỉ production)
RUN npm install

# Copy toàn bộ mã nguồn vào container
COPY . .

# Tạo thư mục temp_audio và cấp quyền để app không bị lỗi permission
RUN mkdir -p /app/temp_audio && chown -R node:node /app/temp_audio

# Chuyển sang user 'node' (không dùng root để bảo mật)
USER node

# Mở cổng 3000
EXPOSE 3000

# Lệnh khởi chạy ứng dụng
CMD ["npm", "start"]
