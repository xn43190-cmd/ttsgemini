FROM node:20-alpine

# Cài đặt bộ công cụ biên dịch (cần thiết cho các gói C++ như lamejs)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./

# Cài đặt dependencies
RUN npm ci --only=production

# Xóa công cụ biên dịch để image nhẹ hơn sau khi build
RUN apk del python3 make g++

COPY . .

# Cấp quyền cho user node
RUN mkdir -p temp_audio && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "start"]
